FROM node:22-bookworm-slim AS base

ENV CI=true
ENV HUSKY=0

ARG APT_MIRROR="mirrors.tencentyun.com"
ARG NPM_REGISTRY="https://registry.npmmirror.com"

RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources || true; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    openssh-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

WORKDIR /app

FROM base AS deps-root
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS deps-web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM base AS deps-agent
WORKDIR /app/agent/runner
COPY agent/runner/package.json agent/runner/package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app

COPY --from=deps-root /app/node_modules ./node_modules
COPY --from=deps-web /app/web/node_modules ./web/node_modules
COPY --from=deps-agent /app/agent/runner/node_modules ./agent/runner/node_modules
COPY . .

RUN npm run build \
  && cd web && npm run build \
  && cd /app/agent/runner && npm run build
RUN npm prune --omit=dev \
  && cd agent/runner && npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

ARG APT_MIRROR="mirrors.tencentyun.com"

RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources || true; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    openssh-client \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 nanoclaw \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash nanoclaw

ENV NODE_ENV=production
ENV NODE_OPTIONS=--use-system-ca
ENV NANOCLAW_LOG_STDOUT=true
ENV HOME=/home/nanoclaw

WORKDIR /app

RUN mkdir -p /app/store /app/groups /app/data /app/logs /data/logs "$HOME/.config/nanoclaw" \
  && chown -R 10001:10001 /app /data/logs "$HOME"

COPY --from=builder --chown=10001:10001 /app/package.json ./package.json
COPY --from=builder --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=builder --chown=10001:10001 /app/dist ./dist
COPY --from=builder --chown=10001:10001 /app/web/dist ./web/dist
COPY --from=builder --chown=10001:10001 /app/agent/runner/package.json ./agent/runner/package.json
COPY --from=builder --chown=10001:10001 /app/agent/runner/node_modules ./agent/runner/node_modules
COPY --from=builder --chown=10001:10001 /app/agent/runner/dist ./agent/runner/dist
COPY --from=builder --chown=10001:10001 /app/agent/skills ./agent/skills
COPY --from=builder --chown=10001:10001 /app/shared ./shared

EXPOSE 3377

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
