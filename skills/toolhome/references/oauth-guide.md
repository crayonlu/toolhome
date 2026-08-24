# OAuth Guide

## Two Registration Methods

ToolHome supports two OAuth client registration methods for upstream MCP servers:

1. **URL-based Client Metadata** (RFC 9728, default): ToolHome publishes a client metadata document at `https://<public-url>/oauth/upstream/client/<credential-id>`. The upstream authorization server fetches this document to register the client.

2. **Dynamic Client Registration (DCR)**: ToolHome POSTs client metadata to the upstream's `registration_endpoint`. The server returns a client ID.

The method is controlled by `settings.urlClientId` per server:
- `true` (default) = URL-based
- `false` = DCR
- `undefined` = inherit global `MCP_HOME_OAUTH_URL_CLIENT_ID` (default `true`)

## Per-Server Configuration

Set via CLI:
```bash
toolhome api PATCH /api/v1/servers/<id> -d '{"settings":{"urlClientId":false}}'
```

Or via the web console: Server edit form -> "OAuth client registration" dropdown.

## Provider Compatibility

| Provider | Recommended Method | Notes |
|---|---|---|
| **Cloudflare** | DCR (`urlClientId: false`) | URL-based fails: 503 fetching from proxied origin |
| **Notion** | DCR (`urlClientId: false`) | URL-based fails: "Invalid client" |
| **Linear** | DCR (`urlClientId: false`) | URL-based fails: "Invalid client" |
| **GitHub** | PAT (not OAuth) | OAuth server doesn't support DCR; metadata discovery requires auth. Use a Personal Access Token as a bearer credential |
| **Slack** | URL-based (default) | No DCR endpoint; URL-based should work |
| **Stripe** | URL-based (default) | No DCR endpoint |
| **Figma** | URL-based (default) | No DCR endpoint |
| **Sentry** | URL-based (default) | No DCR endpoint |
| **Supabase** | URL-based (default) | No DCR endpoint |
| **Vercel** | Not compatible | Only approves localhost callbacks; incompatible with remote gateway |

## Authorization Flow

```bash
toolhome credential authorize <name>
```

1. Resolves credential by name (or ID)
2. Calls `POST /api/v1/credentials/:id/authorize`
3. Opens the authorization URL in the browser
4. Waits, polling credential status every 2s
5. Reports success, failure, or timeout (default 600s)

### Force Re-authorization

```bash
toolhome credential authorize <name> --force
```

Clears the stored client information and re-registers. Use when switching registration methods or changing accounts.

## Troubleshooting OAuth

### "Incompatible auth server: does not support dynamic client registration"

The upstream doesn't have a `registration_endpoint`. Switch to URL-based:
```bash
toolhome api PATCH /api/v1/servers/<id> -d '{"settings":{"urlClientId":true}}'
```

### "Invalid client. The clientId provided does not match."

URL-based metadata was rejected by the upstream. Switch to DCR:
```bash
toolhome api PATCH /api/v1/servers/<id> -d '{"settings":{"urlClientId":false}}'
```

### "invalid_redirect_uri"

The upstream only approves specific redirect URIs (e.g., Vercel only allows `http://localhost:<port>/callback`). This is incompatible with a remote gateway. Use a PAT or keep the MCP in the harness locally.

### OAuth metadata fetch fails (503)

If the ToolHome domain is behind a CDN/proxy (e.g., Cloudflare), the upstream's auth server may fail to fetch the client metadata document. Fix: use DNS-only (grey cloud) for the domain, or switch to DCR.

### Credential shows "Expired"

OAuth access tokens expire (typically 1 hour). ToolHome refreshes them lazily on connection. The web console auto-refreshes expired OAuth credentials on page load. Manual refresh:
```bash
toolhome credential test <id>
# or
toolhome server refresh <server-id>
```
