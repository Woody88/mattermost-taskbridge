# mattermost-taskbridge
#
# Three stages:
#   1. `bd`     — fetches the prebuilt gastownhall/beads release for the target
#                  architecture. Runs natively on $TARGETPLATFORM.
#   2. `build`  — runs natively on $BUILDPLATFORM and uses `bun build --compile
#                  --target=bun-linux-arm64-musl` to cross-compile the entire
#                  app + bun runtime into a single self-contained binary. No
#                  QEMU emulation involved; the bun toolchain handles the
#                  cross-compile end-to-end.
#   3. runtime  — Ubuntu 24.04 + git + tini + the two binaries. Ubuntu 24.04
#                  is required because bd v1.0.0 dynamically links against
#                  libicui18n.so.74 (ICU 74). Alpine 3.20 ships ICU 74 in
#                  icu-libs but it's musl-built and incompatible with the
#                  glibc bd binary. Debian bookworm only has ICU 72. Ubuntu
#                  24.04 (Noble) has libicu74 native.
#
# The bun-compiled binary uses bun's musl-static variant so it runs unchanged
# on the glibc-based Ubuntu runtime — bun's musl build is fully statically
# linked and portable.
#
# Architecture A3 (see ADR obsidian-mcp-server-l75): each project has its
# own bd database stored on its github repo's refs/dolt/data via dolt's
# git+https Dolt remote protocol. The cluster pod uses bd v1.0.0's embedded
# Dolt mode — no long-lived dolt sql-server process is needed. The
# entrypoint loops over projects.json and bootstraps each project's
# embedded dolt store on first boot via `dolt clone`.
ARG BD_VERSION=1.0.0
ARG DOLT_VERSION=1.86.0
ARG BUN_VERSION=1.3

# ---------- bd binary (target arch) ----------
FROM --platform=$TARGETPLATFORM alpine:3.20 AS bd
ARG BD_VERSION
ARG TARGETARCH
RUN apk add --no-cache curl tar ca-certificates \
 && curl -fsSL -o /tmp/bd.tar.gz \
      "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && mkdir -p /out \
 && tar -xzf /tmp/bd.tar.gz -C /out \
 && chmod +x /out/bd

# ---------- dolt binary (target arch) ----------
# bd uses dolt as its backing engine. In v1.0.0 with embedded mode, bd
# imports dolt as a library, but our entrypoint also runs `dolt clone`
# directly to bootstrap the embedded store from the git+https Dolt remote.
# So we still ship the dolt CLI binary alongside bd.
FROM --platform=$TARGETPLATFORM alpine:3.20 AS dolt
ARG DOLT_VERSION
ARG TARGETARCH
RUN apk add --no-cache curl tar ca-certificates \
 && curl -fsSL -o /tmp/dolt.tar.gz \
      "https://github.com/dolthub/dolt/releases/download/v${DOLT_VERSION}/dolt-linux-${TARGETARCH}.tar.gz" \
 && mkdir -p /out \
 && tar -xzf /tmp/dolt.tar.gz --strip-components=2 -C /out dolt-linux-${TARGETARCH}/bin/dolt \
 && chmod +x /out/dolt

# ---------- bun cross-compile (build arch, fast) ----------
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src    ./src
COPY config ./config
# --target picks the produced binary's architecture, NOT the build host's.
# Bun ships its own cross-compiler so this runs at native speed on x86_64
# and emits an aarch64 ELF. We use bun-linux-arm64 (glibc, NOT the
# -musl variant) because the runtime image is Ubuntu 24.04 (glibc).
# We tried -musl initially expecting it to be fully static, but the bun
# musl-static binary still dynamically links against /lib/ld-musl-aarch64.so.1
# at runtime, which Ubuntu doesn't provide. The glibc variant uses the
# system loader at /lib/ld-linux-aarch64.so.1 which Ubuntu has natively.
RUN mkdir -p /out \
 && bun build \
      --compile \
      --minify \
      --sourcemap \
      --target=bun-linux-arm64 \
      src/main.ts \
      --outfile /out/taskbridge \
 && file /out/taskbridge || true

# ---------- runtime (target arch) ----------
FROM --platform=$TARGETPLATFORM ubuntu:24.04 AS runtime
# Required runtime libraries:
#   - git, openssh-client, ca-certificates: for cloning project repos and
#     for dolt's git+https remote protocol
#   - tini: PID 1 reaper / signal forwarder
#   - libicu74, libzstd1: bd v1.0.0 dynamically links against these. Without
#     libicu74 specifically, bd fails to start with
#     "libicui18n.so.74: cannot open shared object file: No such file or
#     directory". Ubuntu 24.04 (Noble) is the first stable distro with ICU 74
#     packaged natively as `libicu74`.
#   - procps: gives us a real `pkill -f` for any future cleanup needs
#     (busybox's pkill lacks -f). Currently unused after the embedded-mode
#     migration removed the long-lived dolt server cleanup, but kept as
#     belt-and-suspenders.
#   - jq: parse projects.json in entrypoint.sh cleanly
#
# We deliberately do NOT install libgcc-s1 / libstdc++6 explicitly because
# they're already in the ubuntu:24.04 base image (they're transitively
# required by libicu74's stack).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
      tini \
      libicu74 \
      libzstd1 \
      procps \
      jq \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r taskbridge \
 && useradd -r -g taskbridge -u 10001 -d /app -s /usr/sbin/nologin taskbridge \
 && mkdir -p /data/repos /app/config \
 && chown -R taskbridge:taskbridge /data /app

COPY --from=bd    /out/bd          /usr/local/bin/bd
COPY --from=dolt  /out/dolt        /usr/local/bin/dolt
COPY --from=build /out/taskbridge  /app/taskbridge
COPY --chown=taskbridge:taskbridge config/projects.json /app/config/projects.json
COPY --chown=taskbridge:taskbridge --chmod=0755 docker/entrypoint.sh /app/entrypoint.sh

WORKDIR /app
USER taskbridge

ENV PORT=3100 \
    REPOS_DIR=/data/repos \
    PROJECTS_CONFIG_PATH=/app/config/projects.json \
    NODE_ENV=production

EXPOSE 3100

# tini as PID 1 so SIGTERM from k8s is forwarded cleanly through the
# entrypoint wrapper to taskbridge. The wrapper bootstraps each configured
# project's embedded dolt store from its git+https Dolt remote on first
# boot, then waits on taskbridge — see docker/entrypoint.sh for details.
# Ubuntu's tini binary lives at /usr/bin/tini (alpine had it at /sbin/tini).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/entrypoint.sh"]
