FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @ast-grep/cli@0.51.0 prettier@3.9.10 \
 && npm cache clean --force

WORKDIR /workspace

CMD ["sleep", "infinity"]
