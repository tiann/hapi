# Plugins

HAPI plugins are trusted local extension packages. Use them when you want to add a small, reusable behavior without changing HAPI core.

This page is the human map. For exact contracts, use the JSON Schemas, OpenAPI file, and source files linked at the end.

## Architecture

```text
Plugin package
┌──────────────────────────────────────────────┐
│ hapi.plugin.json                             │
│ - declares runtimes                          │
│ - declares Web descriptors                   │
│ - declares capabilities, config, permissions │
└──────────────────┬───────────────────────────┘
                   │ validate / install / enable
                   ▼
┌──────────────────┬──────────────────┬──────────────────┐
│ Web              │ Hub              │ Runner           │
│ descriptors only │ trusted local JS │ trusted local JS │
│ no plugin JS     │ notifications    │ spawn options    │
│ settings UI      │ message actions  │ env/hooks/agents │
└──────────────────┴──────────────────┴──────────────────┘
                   │
                   ▼
        HAPI core keeps control of auth,
        namespaces, DB, RPC, SSE, Socket.IO,
        install plans, and lifecycle.
```

## Which plugin type should I start with?

| Goal | Start with |
|---|---|
| Add a settings panel or badge | Web descriptor |
| Send a notification or handle a chat action | Hub runtime |
| Change how remote sessions spawn | Runner runtime |
| Add a chat composer button | Web descriptor + Hub message action |
| Add a new agent backend | Runner agent adapter |

Start with one position. Add cross-runtime capabilities only when the feature really needs Web + Hub + Runner parts.

## Smallest development loop

From the HAPI repo root:

```bash
bun run plugin:create -- com.example.my-plugin --template hub-notification
bun run plugin:validate -- plugins/com.example.my-plugin
hapi plugins install-local ./plugins/com.example.my-plugin --target hub --enable --reload
hapi plugins list --target hub
hapi plugins doctor com.example.my-plugin
```

For Runner plugins, install on a Runner machine:

```bash
hapi plugins install-local ./plugins/com.example.my-plugin --target runner:<machineId> --enable --reload
```

For a packaged install flow:

```bash
bun run plugin:pack -- plugins/com.example.my-plugin --out /tmp/com.example.my-plugin.tgz
hapi plugins install-package /tmp/com.example.my-plugin.tgz --dry-run --json
```

## Minimal file layout

```text
plugins/com.example.my-plugin/
├── hapi.plugin.json
└── dist/
    └── hub.js       # only when the plugin has a Hub runtime
```

A descriptor-only Web plugin may only need `hapi.plugin.json`.

## Minimal Hub runtime

`hapi.plugin.json`:

```json
{
    "id": "com.example.my-plugin",
    "name": "My Plugin",
    "version": "0.1.0",
    "pluginApiVersion": "0.1",
    "runtimes": {
        "hub": { "entry": "dist/hub.js" }
    },
    "contributions": {
        "hub": {
            "notificationChannels": [
                { "id": "logger", "displayName": "Logger" }
            ]
        }
    }
}
```

`dist/hub.js`:

```js
export function activate(ctx) {
    ctx.notifications.registerChannel({
        async send(event) {
            ctx.logger.info('notification type=%s session=%s', event.type, event.session.id)
        }
    })
}
```

## Safety model

- Hub and Runner runtime plugins are trusted local JavaScript, not sandboxed code.
- Web never executes plugin JavaScript; it only renders validated descriptors.
- Runtime entry paths must stay inside the plugin root.
- Secrets come from environment variables through `ctx.secrets.get(name)`.
- Network requests should use `ctx.network.fetch` and declare `permissions.network`.
- Plugins do not receive raw SQLite, Store, Socket.IO, SSE, SyncEngine, or RPC gateway objects.

## Reference map

Human reference:

- [Plugin API reference](/reference/plugin-api/) — short map and source links.
- [Manifest reference](/reference/plugin-api/manifest) — common `hapi.plugin.json` fields.
- [Runtime reference](/reference/plugin-api/runtimes) — Hub, Runner, and agent extension entry points.
- [Web descriptors](/reference/plugin-api/web-descriptors) — descriptor-only UI primitives.
- [Marketplace](/reference/plugin-api/marketplace) — source-first catalog flow.

Machine contracts:

- [OpenAPI JSON](/plugin-api/openapi.json)
- [JSON Schemas](/reference/plugin-api/schemas)

Source of truth for AI-assisted development:

- `shared/src/plugins/sdk.ts`
- `shared/src/plugins/manifest.ts`
- `shared/src/plugins/admin.ts`
- `hub/src/plugins/`
- `cli/src/runner/plugins/`
- `scripts/create-plugin.ts`
- `scripts/validate-plugin.ts`
- `scripts/pack-plugin.ts`
