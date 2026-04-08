#!/bin/sh
# mattermost-taskbridge container entrypoint (bd v1.0.0 + Architecture A3)
#
# bd v1.0.0's embedded Dolt mode eliminates the long-lived dolt sql-server
# lifecycle that the previous (0.61.0) entrypoint had to manage. Each
# project's bd database lives in .beads/embeddeddolt/<dbname>, bootstrapped
# from the project's git+https Dolt remote on first boot via `dolt clone`.
# bd's auto-push debounce (5 min default) handles ongoing sync to github
# without a custom polling loop. See ADR obsidian-mcp-server-l75 for the
# full architecture rationale and obsidian-mcp-server-wpq for what this
# replaces.
#
# Boot sequence:
#   1. Start taskbridge in the background. Its existing ensureRepos
#      startup task does the per-project `git clone` / `git pull`.
#   2. For each configured project, wait for the .git dir to appear,
#      then `dolt clone git+https://...` into .beads/embeddeddolt/<dbname>
#      if it doesn't already exist on the PVC.
#   3. Wait on taskbridge so tini forwards SIGTERM cleanly through the
#      wrapper at shutdown.
#
# Idempotent: container restarts skip the dolt clone for any project
# whose embedded dolt dir already exists on the PVC. The PVC is RWO so
# we always have a single replica writing.

set -eu

REPOS_DIR="${REPOS_DIR:-/data/repos}"
PROJECTS_CONFIG_PATH="${PROJECTS_CONFIG_PATH:-/app/config/projects.json}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-60}"

# If GITHUB_TOKEN is set in the environment (mounted from the
# taskbridge-secrets ExternalSecret), wire up a git credential helper
# that supplies it for any HTTPS clone — both the per-project `git clone`
# done by taskbridge's ensureRepos AND the `dolt clone git+https://...`
# done in this script for the embedded dolt bootstrap. Without this,
# private project repos return 403 on clone. Public repos work with or
# without the token.
#
# The helper is a one-line shell function (no extra files to manage)
# using the documented x-access-token username convention for fine-
# grained PATs and GitHub App installation tokens.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "[entrypoint] GITHUB_TOKEN present — configuring git credential helper"
  git config --global credential.helper \
    '!f() { echo "username=x-access-token"; echo "password=${GITHUB_TOKEN}"; }; f'
else
  echo "[entrypoint] no GITHUB_TOKEN set — assuming public-repo-only configuration"
fi

echo "[entrypoint] starting taskbridge in background (it will run ensureRepos)"
/app/taskbridge &
TB_PID=$!

# Emit one line per configured project: "<key> <repo_url> <branch>"
project_lines() {
  jq -r '.projects[] | "\(.key) \(.repo) \(.branch // "main")"' "$PROJECTS_CONFIG_PATH"
}

# Wait for taskbridge's ensureRepos to clone a given project's repo. Returns
# 0 once .git is present, 1 on timeout.
wait_for_repo() {
  key=$1
  i=0
  while [ $i -lt "$BOOT_TIMEOUT" ]; do
    if [ -d "$REPOS_DIR/$key/.git" ]; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Bootstrap the embedded dolt store for a project from its git+https Dolt
# remote. The github repo's refs/dolt/data ref carries the canonical bd
# state, populated by `bd dolt push` from the dev box. Idempotent — skips
# if the embedded dolt dir already exists.
#
# Database name follows bd v1.0.0's convention: hyphens in the project key
# become underscores in the dolt database directory name (e.g. project key
# "mattermost-taskbridge" becomes db name "mattermost_taskbridge").
bootstrap_dolt() {
  key=$1
  repo_url=$2
  repo="$REPOS_DIR/$key"
  dbname=$(echo "$key" | tr - _)
  doltdir="$repo/.beads/embeddeddolt/$dbname"

  if [ -d "$doltdir" ]; then
    echo "[entrypoint]   $key embedded dolt already bootstrapped at $doltdir"
    return 0
  fi

  # Skip the local-tree case (repo: ".") since there's no remote to clone
  # from. taskbridge in the cluster never uses repo=".", but be defensive.
  if [ "$repo_url" = "." ]; then
    echo "[entrypoint]   $key has repo='.' — skipping dolt bootstrap"
    return 0
  fi

  echo "[entrypoint]   $key bootstrapping embedded dolt from git+https Dolt remote"
  mkdir -p "$repo/.beads/embeddeddolt"
  cd "$repo/.beads/embeddeddolt"
  if /usr/local/bin/dolt clone "git+$repo_url" "$dbname"; then
    echo "[entrypoint]   $key bootstrapped successfully"
    cd /app
    return 0
  else
    echo "[entrypoint]   ERROR: dolt clone failed for $key — bd will return empty for this project"
    cd /app
    return 1
  fi
}

# Process each project. We use a temp file to keep `while read` out of a
# subshell so the loop's exit status is meaningful and any vars survive.
project_lines > /tmp/projects.list
while read -r key repo_url branch; do
  echo "[entrypoint] waiting for $key clone (timeout ${BOOT_TIMEOUT}s)"
  if wait_for_repo "$key"; then
    bootstrap_dolt "$key" "$repo_url" || true
  else
    echo "[entrypoint] WARNING: timeout waiting for $key repo clone — bd will return empty for this project"
  fi
done < /tmp/projects.list
# /tmp/projects.list is intentionally kept; the background sync loop
# below re-reads it on every tick. Cleaned up on container exit.

echo "[entrypoint] all projects processed, starting inbound sync loop"

# Background inbound sync loop. bd v1.0.0's auto-push handles outbound
# sync (dev box → github via refs/dolt/data, 5min debounce). It does NOT
# auto-pull from the remote — without this loop, the cluster pod's bd
# state would stay frozen at whatever was cloned at boot, and dev-box
# writes would never reach Mattermost slash commands until pod restart.
#
# Per-project `bd dolt pull` is cheap when there's nothing new (a refs
# check) and bounded by SYNC_INTERVAL when there is. The whole loop
# requires GITHUB_TOKEN because bd dolt pull internally does a
# `git push refs/dolt/blobstore/origin/...` for blobstore mirroring as
# part of every pull (verified empirically; see ADR
# obsidian-mcp-server-l75 Phase C notes).
#
# Without GITHUB_TOKEN we still loop but bd dolt pull will fail at the
# git push step. The loop logs the failure and continues — bd reads
# stay at the boot snapshot in that case, which is the same degraded
# mode as the no-credentials boot path.
SYNC_INTERVAL="${SYNC_INTERVAL:-60}"
(
  while true; do
    sleep "$SYNC_INTERVAL"
    while read -r key _ _; do
      repo="$REPOS_DIR/$key"
      [ -d "$repo/.beads/embeddeddolt" ] || continue
      cd "$repo"
      out=$(/usr/local/bin/bd dolt pull 2>&1) || true
      # Only log when something interesting happened (suppress the
      # noisy "Pulling from Dolt remote..." / "Pull complete." pair
      # on every tick).
      case "$out" in
        *"error"*|*"Error"*|*"fatal"*|*"fast-forward"*|*"updated"*)
          echo "[sync-pull] $key: $(echo "$out" | tail -3 | tr '\n' ' ')"
          ;;
      esac
      cd /app
    done < /tmp/projects.list
  done
) &
SYNC_PID=$!
echo "[entrypoint] inbound sync loop started (pid $SYNC_PID, every ${SYNC_INTERVAL}s)"

echo "[entrypoint] handing off to taskbridge (pid $TB_PID)"
wait $TB_PID
