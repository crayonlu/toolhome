# ToolHome v0.7.1

## npm `bin` paths no longer trip the publish-time correction

`package.json` declared the CLI entry points as `./dist/server/cli/main.js`.
npm 11 normalizes that to `dist/server/cli/main.js` during publish and printed
a confusing "script name ... was invalid and removed" warning — the installed
bin links were correct all along, but the message suggested otherwise.

The declared paths now match the normalized form (npm already rewrote the file
during the 0.7.0 publish), so `npm publish` is quiet and the warning cannot be
misread as a missing CLI. Verified by installing the published 0.7.0 tarball:
`toolhome --version` and the `mcp-home` alias both resolve.

## Upgrade

Server image: `ghcr.io/crayonlu/toolhome:v0.7.1`. CLI: `npm install -g toolhome@0.7.1`.

No runtime changes.
