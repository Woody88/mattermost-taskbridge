# syntax=docker/dockerfile:1.7
#
# mattermost-taskbridge
#
# Three stages:
#   1. `bd`     — fetches the prebuilt steveyegge/beads release for the target
#                  architecture. Runs natively on $TARGETPLATFORM.
#   2. `build`  — runs natively on $BUILDPLATFORM and uses `bun build --compile
#                  --target=bun-linux-arm64-musl` to cross-compile the entire
#                  app + bun runtime into a single self-contained binary. No
#                  QEMU emulation involved; the bun toolchain handles the
#                  cross-compile end-to-end.
#   3. runtime  — minimal alpine + git + tini + the two binaries. No bun,
#                  no node_modules, no python.
#
# The Bun binary path is fully static-linked against musl, so an alpine
# runtime is appropriate (and tiny).
ARG BD_VERSION=0.61.0
ARG BUN_VERSION=1.3-alpine

# ---------- bd binary (target arch) ----------
FROM --platform=$TARGETPLATFORM alpine:3.20 AS bd
ARG BD_VERSION
ARG TARGETARCH
RUN apk add --no-cache curl tar ca-certificates \
 && curl -fsSL -o /tmp/bd.tar.gz \
      "https://github.com/steveyegge/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && mkdir -p /out \
 && tar -xzf /tmp/bd.tar.gz -C /out \
 && chmod +x /out/bd

# ---------- bun cross-compile (build arch, fast) ----------
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src    ./src
COPY config ./config
# --target picks the produced binary's architecture, NOT the build host's.
# Bun ships its own cross-compiler so this runs at native speed on x86_64
# and emits an aarch64-musl ELF.
RUN mkdir -p /out \
 && bun build \
      --compile \
      --minify \
      --sourcemap \
      --target=bun-linux-arm64-musl \
      src/main.ts \
      --outfile /out/taskbridge \
 && file /out/taskbridge || true

# ---------- runtime (target arch) ----------
FROM --platform=$TARGETPLATFORM alpine:3.20 AS runtime
# `bun build --compile` produces a binary that depends on libgcc + libstdc++
# (for unwinding, integer math intrinsics, C++ exception handling). Alpine
# doesn't ship these by default, so we install them explicitly. Without
# them the binary aborts immediately with `Error relocating: ... symbol
# not found` for _Unwind_*, __floatunsitf, __cxa_demangle, etc.
RUN apk add --no-cache git openssh-client ca-certificates tini libgcc libstdc++ \
 && addgroup -S taskbridge \
 && adduser -S -G taskbridge -u 10001 -h /app -s /sbin/nologin taskbridge \
 && mkdir -p /data/repos /app/config \
 && chown -R taskbridge:taskbridge /data /app

COPY --from=bd    /out/bd          /usr/local/bin/bd
COPY --from=build /out/taskbridge  /app/taskbridge
COPY --chown=taskbridge:taskbridge config/projects.json /app/config/projects.json

WORKDIR /app
USER taskbridge

ENV PORT=3100 \
    REPOS_DIR=/data/repos \
    PROJECTS_CONFIG_PATH=/app/config/projects.json \
    NODE_ENV=production

EXPOSE 3100

# tini as PID 1 so SIGTERM from k8s is forwarded cleanly to taskbridge.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/taskbridge"]
