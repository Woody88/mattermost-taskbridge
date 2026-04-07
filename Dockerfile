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
ARG DOLT_VERSION=1.86.0
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

# ---------- dolt binary (target arch) ----------
# bd uses dolt as its backing SQL server. Without it bd commands fail at
# startup with "dolt is not installed". The release tarball ships a single
# Go binary; the layout inside is `dolt-linux-arm64/bin/dolt`.
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
# Two libc gotchas to handle in this image:
#   1. The bun-compiled binary depends on libgcc + libstdc++ (for unwinding,
#      integer math intrinsics, C++ exception handling). Without them it
#      aborts at startup with `Error relocating: ... symbol not found` for
#      _Unwind_*, __floatunsitf, __cxa_demangle, etc.
#   2. The bd binary from steveyegge/beads is glibc-linked and looks for
#      `/lib/ld-linux-aarch64.so.1`. Alpine ships musl
#      (`/lib/ld-musl-aarch64.so.1`) so a bare alpine fails at exec time
#      with "no such file or directory" even though the binary is right
#      there. `gcompat` installs the glibc-compat loader and symlinks it
#      into the right spot so the prebuilt glibc binary runs unchanged.
RUN apk add --no-cache git openssh-client ca-certificates tini libgcc libstdc++ gcompat procps \
 && addgroup -S taskbridge \
 && adduser -S -G taskbridge -u 10001 -h /app -s /sbin/nologin taskbridge \
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
# entrypoint wrapper to taskbridge. The wrapper pre-starts a long-lived
# dolt server for each configured project before taskbridge begins
# serving requests; see docker/entrypoint.sh for the details.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/entrypoint.sh"]
