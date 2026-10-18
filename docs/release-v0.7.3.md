# ToolHome v0.7.3

Deploys stop moving a gigabyte, and dual-stack upstreams connect reliably.

## The app image is built on the server

The deploy job used to `docker save` the app image (~1.45 GB) and `scp` it from the GitHub runner,
which took 20+ minutes on the Aliyun link. It now ships the 3 MB build context (`dist/`,
`web/dist/`, the manifest and the Dockerfile) and runs `docker build` on the deployment host. The
npm, apk and uv layers are cached there, so a normal deploy rebuilds only the artifact layers.

Two build arguments make the first and every later build workable on a slow international link,
and can be set per deployment in `/opt/mcp-home/.build-env`:

```sh
BUILD_APK_MIRROR=mirrors.tuna.tsinghua.edu.cn/alpine
BUILD_NPM_REGISTRY=https://registry.npmmirror.com
```

`apk add curl` through the default Alpine CDN took minutes there; through the Tsinghua mirror it
takes 3.5 s.

## The image is 394 MB instead of 1.45 GB

The Go toolchain (~400 MB installed) was in the runtime image although no catalog entry uses the
`go` installer. It is now opt-in: build with `--build-arg WITH_GO=true` for a custom Go-based
entry.

## Dual-stack upstreams: IPv4 first, with a longer first attempt

0.7.2 disabled happy-eyeballs to fix `ETIMEDOUT` on upstreams with AAAA records, which fixed
Penpot but broke Notion: with autoselection off, only the first A record is tried, and one of
Notion's refuses connections.

The image now sets:

```
NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"
```

Ordering keeps IPv4 first, the longer attempt budget lets a healthy IPv4 connection win before an
IPv6 attempt is started and fails (which used to abort the whole connect), and happy-eyeballs
stays on so multiple A records are still tried. Measured in the deployed container, five
consecutive fresh processes: `design.penpot.app` 200 ×5, `mcp.notion.com` 401 (auth challenge,
connection fine) ×5.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.3`. CLI: `npm install -g toolhome@0.7.3`.

No schema or API changes. The deployment host needs the Docker CLI (present) and outbound access
to npm and the Alpine CDN (or the mirrors above).

## Validation

Server typecheck and 393 tests. The server-side build was run twice: 394 MB on the first build,
55 s on the second (only the npm layer, invalidated by the version bump, rebuilt). Both upstream
checks above were run in the deployed container.
