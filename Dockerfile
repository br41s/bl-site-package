# Build stage: install dependencies.
#
# Node 22, not 20, and the version is load-bearing rather than cosmetic.
# better-sqlite3 ships prebuilt binaries per Node ABI, and 12.11.1 publishes
# them for ABI 127 (Node 22), 137 (Node 24) and 141/147 — but nothing for ABI
# 115 (Node 20). On Node 20 there was no binary to download for glibc OR musl,
# so npm fell through to compiling from source, and node-gyp then had to fetch
# the Node headers for a musl target from unofficial-builds.nodejs.org — a
# volunteer-run mirror. That fetch timed out and failed the deploy:
#
#   prebuild-install warn No prebuilt binaries found (libc=musl target=20.20.2)
#   gyp http GET https://unofficial-builds.nodejs.org/.../node-v20.20.2-headers.tar.gz
#   gyp ERR! ... attempt 1 failed with ETIMEDOUT
#
# Intermittently, which is why some deploys of identical code went green on a
# retry. On Node 22 prebuild-install finds
# better-sqlite3-v12.11.1-node-v127-linuxmusl-x64.tar.gz, node-gyp never runs,
# and the build stops depending on that mirror being up.
#
# Node 20 also went end-of-life on 2026-04-30, so it stopped receiving security
# fixes. 22 is supported to 2027-04-30, and is already what a client's Plesk
# host runs (22.23.2) and what the repo is developed against — the container
# was the odd one out.
FROM node:22-alpine AS build
WORKDIR /app
# Kept as a fallback, not the normal path. With the ABI 127 prebuild available
# nothing here should be needed — but if a future better-sqlite3 bump ever
# drops this ABI, a source build that can run beats a deploy that cannot.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
# npm ci installs the exact tree from the committed package-lock.json, so
# every client build is reproducible. --omit=dev keeps the image lean;
# @11ty/eleventy is a runtime dependency (see src/build/rebuild.js), so it
# stays installed.
RUN npm ci --omit=dev

# Runtime stage: lean image, no build tools. The better-sqlite3 binary rides
# along in node_modules and is ABI- and libc-specific, so this base image must
# stay on the same Node major and the same libc as the build stage above.
FROM node:22-alpine
WORKDIR /app
# Enables HSTS in server.js and disables dev-only behavior
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY . .
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "src/server.js"]
