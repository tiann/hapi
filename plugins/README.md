# HAPI source plugins

This directory contains first-party marketplace plugin source.
The architecture rules here mirror the rules for every HAPI plugin, including external marketplace plugins, uploaded packages, and local user plugins.

Layout:

```text
plugins/<plugin-id>/
  hapi.plugin.json        # runtime manifest
  hapi.marketplace.json   # marketplace display/search metadata
  src/*.js                # ESM runtime entries imported by Hub/Runner
```

Create a new plugin scaffold with:

```bash
bun run plugin:create -- com.example.my-plugin --template hub-notification
bun run plugin:create -- com.example.runner-env --template runner-env
bun run plugin:create -- com.example.web-only --template web-descriptor
```

Use `--dir <path>` for a non-`plugins/` development directory. Generated runtime files stay plain ESM JavaScript with JSDoc type hints; there is still no plugin-local build step.

Rules:

- Plugins must be real extension implementations, not switches for feature logic that still lives in core.
- Core app code must stay plugin-agnostic: no plugin ID/name/contribution ID branches, plugin-specific routes, or plugin-specific config/env handling.
- Declare capabilities and contributions in `hapi.plugin.json`; implement runtime behavior in `src/*.js` via the SDK registration APIs.
- Web UI must use descriptor primitives from the manifest. New primitives must be reusable by any plugin, not tied to one plugin ID.
- Keep runtime entries as plain ESM JavaScript for now; no plugin-local install/build step.
- Do not commit `node_modules/`, `dist/`, package archives, or symlinks.
- Run `bun run marketplace:generate` after editing source plugins.
- Run `bun run marketplace:check` before opening a PR.

Version maintenance checklist:

- Runtime behavior or descriptor change: bump `hapi.plugin.json` `version` with SemVer.
- Public SDK / manifest required-field / extension-point breaking change: evaluate `HAPI_PLUGIN_API_VERSION` and supported versions in `shared/src/plugins/manifest.ts`; keep `docs/reference/plugin-api/manifest.md` accurate.
- Keep `pluginApiVersion` as the contract the plugin actually needs; do not bump it just because the host current API changed if the required APIs still exist.
- Prefer `compatibility.pluginApi` ranges such as `>=0.1 <0.2`; host checks all supported API contracts, not only its current default.
- After editing a first-party plugin, run:

```bash
bun run plugin:validate -- plugins/<plugin-id>
bun run marketplace:generate
bun run marketplace:check
```

- To test upload/install-package flow without committing archives:

```bash
bun run plugin:pack -- plugins/<plugin-id> --out /tmp/<plugin-id>.tgz
```

Generated outputs:

- `marketplace/catalog.v1.json`
- `shared/src/plugins/marketplaceSources.generated.ts`

Hub installs these source plugins by packaging the embedded source tree into the existing install-plan flow, so remote Runner installation still receives bytes through RPC instead of reading this repository path directly.
