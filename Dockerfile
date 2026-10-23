# forge-test-mcp — runs Foundry tests and builds for AI coding agents, over MCP on stdio.
#
# Mount the Foundry project at /project and a cache volume at /cache (the compiler lives there):
#
#   docker run --rm -v "$PWD":/project -v forge-test-mcp-cache:/cache \
#     --entrypoint forge forge-test-mcp build          # once: lets forge install solc (online)
#   docker run -i --rm -v "$PWD":/project -v forge-test-mcp-cache:/cache forge-test-mcp
#
# forge writes out/ and cache/ into the project, so on Linux add --user "$(id -u):$(id -g)" to
# both commands. The server runs forge with --offline; it never downloads anything itself.

FROM node:24-alpine

# forge 1.8.6, the official static Alpine build. Both the release tarball and the forge binary
# in it are checked against the digests of the release's SLSA provenance attestation
# (release.yml@refs/tags/v1.8.6, commit 6bad0a66de7c83f7b33695044138f0f5fa4c5990).
ARG FOUNDRY_VERSION=v1.8.6
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-}" in \
      amd64) tar_sha=1165568a5ae449e9c28bba18f90012b7f89826fa20bd0d0006d4371f5d6dfc3b; \
             forge_sha=6141a465334e5eac4169401df43739f20459f0a65d60d78b8806b444c6362d8e ;; \
      arm64) tar_sha=57c9739c117c3574386b23562ecb780ca2f59121fa2cc9729491c304c1b28f46; \
             forge_sha=27b573995e9fa34bc4eb81d68fda3f92b675bfcf322276d043def535b2c88b17 ;; \
      *) echo "unsupported architecture '${TARGETARCH:-}' (build with BuildKit)" >&2; exit 1 ;; \
    esac; \
    wget -q -O /tmp/foundry.tar.gz \
      "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_alpine_${TARGETARCH}.tar.gz"; \
    echo "${tar_sha}  /tmp/foundry.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin forge; \
    echo "${forge_sha}  /usr/local/bin/forge" | sha256sum -c -; \
    rm /tmp/foundry.tar.gz; \
    forge --version

# Production dependencies first, so this layer is cached across source edits.
WORKDIR /opt/forge-test-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/
COPY README.md LICENSE NOTICE ./

# HOME is where forge keeps solc (svm) and its caches. A world-writable /cache lets the
# container run as the host user (--user) and keep the compiler in a named volume.
RUN mkdir -p /cache && chmod 1777 /cache
ENV HOME=/cache

# The server tests the project in its working directory.
WORKDIR /project
USER node

ENTRYPOINT ["node", "/opt/forge-test-mcp/src/index.js"]
