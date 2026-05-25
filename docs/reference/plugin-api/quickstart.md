# Plugin quickstart

For the shortest path, use the [Plugins guide](/guide/plugins). It shows the architecture, a minimal Hub plugin, and the local install loop.

## Commands

From the HAPI repo root:

```bash
bun run plugin:create -- com.example.my-plugin --template hub-notification
bun run plugin:validate -- plugins/com.example.my-plugin
hapi plugins install-local ./plugins/com.example.my-plugin --target hub --enable --reload
hapi plugins list --target hub
hapi plugins doctor com.example.my-plugin
```

For a package upload flow:

```bash
bun run plugin:pack -- plugins/com.example.my-plugin --out /tmp/com.example.my-plugin.tgz
hapi plugins install-package /tmp/com.example.my-plugin.tgz --dry-run --json
```

For Runner plugins, install on the Runner target:

```bash
hapi plugins install-local ./plugins/com.example.my-plugin --target runner:<machineId> --enable --reload
```

## Examples to read

- `plugins/com.hapi.schedule-send` — Web composer action + Hub message action.
- `plugins/com.hapi.serverchan-notifier` — Hub notification channel.
- `plugins/com.hapi.runner-launch-presets` — Runner spawn options + Web settings descriptor.
- `scripts/create-plugin.ts` — source for the `hub-notification`, `runner-env`, and `web-descriptor` templates.

## Next pages

- [Manifest](./manifest.md)
- [Runtimes](./runtimes.md)
- [Web descriptors](./web-descriptors.md)
- [Schemas](./schemas.md)
