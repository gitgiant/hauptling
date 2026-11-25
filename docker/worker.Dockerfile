# hauptling-worker: the golden image every task container starts from.
# Build context (assembled by `hauptling image build`): hauptling/ (this package) and agy (binary or stub).
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git tmux less procps python3 python3-pip python3-venv build-essential \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
# Package managers pre-provisioned (no download at first use): corepack's pnpm and yarn, cached in a
# COREPACK_HOME every worker uid can read and extend (a repo's pinned `packageManager` version downloads into it).
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@stable --activate \
 && pnpm --version && yarn --version \
 && chmod -R a+rwX /opt/corepack \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex @colbymchenry/codegraph \
 && npm cache clean --force
COPY --chmod=0755 agy /usr/local/bin/agy
COPY hauptling /opt/hauptling
RUN chmod 0755 /opt/hauptling/bin/hauptling.mjs \
 && chmod -R a+rX /opt/hauptling \
 && ln -s /opt/hauptling/bin/hauptling.mjs /usr/local/bin/hauptling \
 && node -e "import('/opt/hauptling/src/vendors.mjs').then(m => m.writeManagedFiles())" \
 && git config --system safe.directory '*' \
 && mkdir -p /home/worker /work && chmod 1777 /home/worker /work \
 && ln -s /home/worker/.vendor/gemini /home/worker/.gemini
# Vendor config lives in the slot's credentials dir, mounted at /home/worker/.vendor.
ENV CODEGRAPH_TELEMETRY=0 HOME=/home/worker CLAUDE_CONFIG_DIR=/home/worker/.vendor/claude CODEX_HOME=/home/worker/.vendor/codex
WORKDIR /work
