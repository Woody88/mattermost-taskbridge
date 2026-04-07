#!/bin/sh
# mattermost-taskbridge container entrypoint
#
# bd's default auto-start-dolt behavior doesn't work reliably when bd is
# invoked as a per-request subprocess (our slash command handlers do this).
# Symptom: the first bd invocation spawns a dolt server, dolt grabs the
# exclusive write lock, bd fails to write the lock file with the port,
# every subsequent bd invocation tries to spawn a new dolt that fails on
# "database locked by another dolt process" and times out after 10s.
#
# The fix is to pre-start exactly ONE long-lived dolt server per configured
# project BEFORE taskbridge begins accepting HTTP traffic, and to clean up
# any stale lock / pid / port files from a previous container lifetime so
# bd writes fresh state.
#
# Chicken-and-egg: dolt can only be started after the repo is cloned, but
# taskbridge itself does the cloning via its ensureRepos startup task. We
# handle this by:
#   1. Kicking off taskbridge in the background.
#   2. Polling for each configured repo's .beads directory to appear.
#   3. For each repo: killing stale dolt state, running `bd dolt start`.
#   4. Waiting for taskbridge (the real PID 1 workload, via tini).
#
# This is a shell wrapper so taskbridge's TypeScript stays unaware of the
# bd server lifecycle. If we later solve the bd-in-cluster issue upstream,
# we can drop this wrapper entirely.

set -eu

REPOS_DIR="${REPOS_DIR:-/data/repos}"
PROJECTS_CONFIG_PATH="${PROJECTS_CONFIG_PATH:-/app/config/projects.json}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-60}"
SYNC_INTERVAL="${SYNC_INTERVAL:-15}"

echo "[entrypoint] starting taskbridge in background"
/app/taskbridge &
TB_PID=$!

# Derive the list of project keys from projects.json. Minimal JSON parsing
# via grep+cut — we don't want to pull in jq just for this.
project_keys() {
  grep -o '"key"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECTS_CONFIG_PATH" \
    | cut -d'"' -f4
}

# Wait for a given repo's .beads directory to exist (taskbridge clones it
# during ensureRepos on boot). Return 0 on success, 1 on timeout.
wait_for_repo() {
  key=$1
  path="$REPOS_DIR/$key/.beads"
  i=0
  while [ $i -lt "$BOOT_TIMEOUT" ]; do
    if [ -d "$path" ]; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

start_dolt_for() {
  key=$1
  repo="$REPOS_DIR/$key"
  echo "[entrypoint] preparing dolt for $key"
  cd "$repo"

  # Clean stale lifecycle state from previous container lifetimes. These
  # files live on the PVC and persist across restarts, so we purge them
  # before starting a fresh dolt. Stale entries here are why the previous
  # container lifetime's bd invocations would fail to find the live dolt.
  rm -f .beads/dolt-server.lock .beads/dolt-server.pid .beads/dolt-server.port

  # Kill any dolt still holding a lock in this data dir. In practice this
  # only hits after a crashed previous lifetime that tini didn't fully
  # reap, but it's cheap insurance.
  pkill -9 -f "dolt.*$repo/.beads/dolt" 2>/dev/null || true
  sleep 1

  # If the .beads/dolt data dir doesn't exist, we need to init from the
  # committed backup JSONLs. bd init creates a fresh dolt, then
  # bd backup restore replays the JSONLs into it.
  if [ ! -d "$repo/.beads/dolt" ]; then
    if [ -f "$repo/.beads/backup/issues.jsonl" ]; then
      echo "[entrypoint]   fresh clone, running bd init + bd backup restore"
      /usr/local/bin/bd init --prefix "$key" >/dev/null 2>&1 || true
      /usr/local/bin/bd backup restore >/dev/null 2>&1 || true
    else
      echo "[entrypoint]   no dolt data and no backup JSONLs — bd will return empty"
      /usr/local/bin/bd init --prefix "$key" >/dev/null 2>&1 || true
    fi
  fi

  # Start a single long-lived dolt server for this project. Returns
  # once the server is accepting connections. Subsequent bd invocations
  # from taskbridge handlers find it via the freshly written lock file.
  echo "[entrypoint]   starting long-lived dolt"
  /usr/local/bin/bd dolt start 2>&1 || {
    echo "[entrypoint]   WARNING: bd dolt start failed for $key"
  }
  cd /app
}

# Wait for each configured project's clone to land, then start dolt for it.
for key in $(project_keys); do
  echo "[entrypoint] waiting for $key clone"
  if wait_for_repo "$key"; then
    start_dolt_for "$key"
  else
    echo "[entrypoint] WARNING: timeout waiting for $key repo to appear"
  fi
done

echo "[entrypoint] dolt boot complete"

# Background sync loop: polls git for new commits every SYNC_INTERVAL
# seconds and runs bd backup restore when anything changed. This gives us
# gitops-native dev→cluster sync without needing a webhook or a Dolt
# remote. Bounded lag, bounded by SYNC_INTERVAL.
#
# Why we can't sync per-request:
#   bd backup restore takes ~7 s even on a no-op database because of the
#   dolt connection overhead. Mattermost's slash command timeout is 3 s.
#   Running bd in the request path blows the budget every time.
#
# Why the git rev-parse short-circuit matters:
#   bd itself has no cheap "is there new data?" check — every bd read
#   also costs ~7 s. But git fetch is ~500 ms and `git rev-parse` is
#   ~40 ms. So we use git as the idempotency check and only run the
#   expensive bd op when git tells us there's actually new data. Most
#   cycles are a ~500 ms no-op.
#
# Safety:
#   Only runs git pull --ff-only so a dev-side force-push won't clobber
#   unexpected local commits (there shouldn't be any in the pod, but
#   belt and suspenders).
#   Every bd write path that lands in Phase 2 will need to commit + push
#   the backup JSONLs back to git, otherwise this loop will keep
#   overwriting the pod-local state.
(
  while true; do
    sleep "$SYNC_INTERVAL"
    for key in $(project_keys); do
      repo="$REPOS_DIR/$key"
      [ -d "$repo/.git" ] || continue
      cd "$repo"
      # Skip silently if offline / fetch fails.
      git fetch --quiet origin main 2>/dev/null || { cd /app; continue; }
      local_head=$(git rev-parse HEAD 2>/dev/null || echo "")
      remote_head=$(git rev-parse origin/main 2>/dev/null || echo "")
      if [ -n "$remote_head" ] && [ "$local_head" != "$remote_head" ]; then
        echo "[sync] $key: $local_head -> $remote_head"
        if git pull --ff-only --quiet 2>/dev/null; then
          /usr/local/bin/bd backup restore 2>&1 | tail -1 || true
          echo "[sync] $key: restore complete"
        else
          echo "[sync] $key: git pull failed (non-fast-forward?)"
        fi
      fi
      cd /app
    done
  done
) &
SYNC_PID=$!

echo "[entrypoint] background sync loop started (pid $SYNC_PID, every ${SYNC_INTERVAL}s)"
echo "[entrypoint] handing off to taskbridge (pid $TB_PID)"
wait $TB_PID
