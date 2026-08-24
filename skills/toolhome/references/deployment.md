# Deployment Guide

## Docker (Recommended)

```yaml
# docker-compose.yml
services:
  toolhome:
    image: ghcr.io/crayonlu/toolhome:latest
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:3344:3344"
    volumes:
      - ./data:/data
    env_file: .env
```

```bash
# .env
MCP_HOME_MASTER_KEY=<32+ char random>
MCP_HOME_BOOTSTRAP_CONTROL_KEY=<32+ char random, different from master>
MCP_HOME_PUBLIC_URL=https://mcp.example.com
MCP_HOME_ALLOWED_HOSTS=mcp.example.com
```

```bash
docker compose up -d
```

## CI/CD (GitHub Actions)

The repo includes `.github/workflows/ci.yml` with three jobs:

1. **test**: server check + test, web typecheck + test
2. **docker**: build dists -> docker build -> push `ghcr.io/crayonlu/toolhome:latest`
3. **deploy**: SSH to server -> `docker compose pull && up -d`

### Required GitHub Secrets

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | Server IP or hostname |
| `DEPLOY_USER` | SSH username |
| `DEPLOY_KEY` | SSH private key (no passphrase) |

### GHCR Package Visibility

After first CI push, set the package to Public:
`github.com/<user>?tab=packages -> toolhome -> Package settings -> Change visibility -> Public`

### Deployment Flow

```
git push main -> test -> docker build + push GHCR -> SSH deploy -> done
git tag v* -> test -> docker build + push :v* tag (no deploy)
```

## Reverse Proxy

Put an HTTPS reverse proxy (nginx/Caddy/openresty) in front. Key requirements:

- **WebSocket/SSE support**: MCP uses Streamable HTTP with SSE responses. The proxy must not buffer SSE.
- **No CDN proxy for the domain**: If behind Cloudflare (orange cloud), SSE POST responses get buffered for ~25s. Use DNS-only (grey cloud) for the ToolHome subdomain.
- **Valid TLS certificate**: OAuth callbacks and URL-based client metadata require HTTPS.

### nginx Example

```nginx
location / {
    proxy_pass http://127.0.0.1:3344;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 600s;
}
```

## Data Persistence

| Path | Content | Persist? |
|---|---|---|
| `/data/toolhome.sqlite` | SQLite database (servers, credentials, keys, events) | Yes (volume) |
| `/data/market/` | Market-installed npm packages | Yes (volume) |
| `/app/dist/` | Server code (baked in image) | No (image) |
| `/app/web-dist/` | Web console (baked in image) | No (image) |

## Local Development

```bash
npm install
npm run dev          # server (tsx watch)
npm run dev:web      # web console (Vite, proxies /api to :3344)
```

## Building from Source

```bash
npm run build        # builds server dist + web dist
docker compose up -d --build   # build image locally
```

The Dockerfile copies prebuilt `dist/` and `web/dist/` from the build context (not built in-container, to avoid memory issues on low-RAM hosts).
