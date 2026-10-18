FROM node:24-alpine AS runtime

# uv / uvx: run Python-based MCP servers (fetch, git, memory, …) from the Market catalog
# docker CLI: run docker-kind Market entries (e.g. markitdown) via `docker run`
# APK_MIRROR lets slow/blocked networks point apk at a local mirror (e.g. mirrors.tuna.tsinghua.edu.cn/alpine).
ARG APK_MIRROR=dl-cdn.alpinelinux.org
# NPM_REGISTRY lets a slow/blocked network use a mirror (e.g. registry.npmmirror.com).
ARG NPM_REGISTRY=https://registry.npmjs.org
# The Go toolchain is deliberately absent: it is ~400 MB in the image and no
# catalog entry uses the `go` installer. A custom Go-based entry needs an image
# built with WITH_GO=true (or its own Dockerfile) instead.
ARG WITH_GO=false
RUN sed -i "s#dl-cdn.alpinelinux.org/alpine#${APK_MIRROR}#g" /etc/apk/repositories && \
    apk add --no-cache curl docker-cli tar unzip $([ "$WITH_GO" = "true" ] && echo go) && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/ && \
    rm -rf /root/.local

ENV NODE_ENV=production
# IPv4 first, with happy-eyeballs kept on and a longer first-attempt budget: an
# IPv6 attempt that fails fast can otherwise abort the whole connection before a
# working IPv4 attempt finishes, while disabling autoselection would stop multiple
# A records from being tried (Notion has one that refuses). Override with
# -e NODE_OPTIONS=… if the deployment network is IPv6-native.
ENV NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"
ENV TOOLHOME_HOST=0.0.0.0
ENV TOOLHOME_PORT=3344
ENV TOOLHOME_DATA_DIR=/data
ENV TOOLHOME_WEB_DIR=/app/web-dist

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=${NPM_REGISTRY}
COPY dist ./dist
COPY web/dist ./web-dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3344
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3344/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/main.js"]
