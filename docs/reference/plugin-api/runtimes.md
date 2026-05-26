# Plugin runtimes

Runtime pages intentionally stay short. For exact TypeScript types, read `shared/src/plugins/sdk.ts` and the generated [JSON Schemas](./schemas.md).

## Hub runtime

Hub plugins run in the Hub process as trusted local JavaScript.

```js
export function activate(ctx) {
    ctx.logger.info('activated')

    ctx.notifications.registerChannel({
        async send(event) {
            ctx.logger.info('notification %s', event.type)
        }
    })
}
```

Common Hub APIs:

| API | Use |
|---|---|
| `ctx.logger` | Redacted plugin logs. |
| `ctx.config.get(key)` | Read non-secret config. |
| `ctx.secrets.get(name)` | Read declared environment secret. |
| `ctx.network.fetch(url, init)` | Fetch with plugin network policy checks. |
| `ctx.notifications.registerChannel(channel)` | Add a notification channel. |
| `ctx.messages.registerAction(action)` | Add a chat/composer message action handler. |

## Runner runtime

Runner plugins run on each target machine as trusted local JavaScript. Use them for local workspace and spawn behavior.

```js
export function activate(ctx) {
    ctx.runtime.registerEnvironmentProvider({
        id: 'example-env',
        async provide() {
            return { env: { EXAMPLE_PLUGIN: '1' } }
        }
    })
}
```

Common Runner APIs:

| API | Use |
|---|---|
| `ctx.runtime.registerSpawnOptionsProvider()` | Provide default New Session values. |
| `ctx.runtime.registerEnvironmentProvider()` | Add environment variables or PATH entries. |
| `ctx.runtime.registerCommandResolver()` | Adjust HAPI CLI arguments through a validated proposal. |
| `ctx.runtime.registerSpawnHook()` | Observe or block a spawn plan. |
| `ctx.actions.register()` | Add generic Runner-side actions. |
| `ctx.agents.registerAdapter()` | Add a plugin-backed agent backend. |
| `ctx.agents.registerCapabilityProvider()` | Add dynamic model/profile/command capability data. |

HAPI validates and audits Runner proposals before applying them. Protected `HAPI_*` and auth/home environment keys are not plugin-overridable.

## Activation lifecycle

```text
install → enable → validate manifest → import runtime entry → activate(ctx)
```

- Disabled or invalid plugins are not imported.
- Runtime entries must stay inside the plugin root after `realpath`.
- Activation has a timeout so a stuck plugin cannot block startup forever.
- Dispose hooks run when a plugin is disabled, reloaded, or replaced.

## Source links

- `shared/src/plugins/sdk.ts`
- `shared/src/plugins/extensionPoints.ts`
- `hub/src/plugins/pluginManager.ts`
- `cli/src/runner/plugins/runnerPluginManager.ts`
- `cli/src/runner/plugins/runnerExtensionPipeline.ts`
