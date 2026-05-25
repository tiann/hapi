# Plugin API reference

This section is a compact map, not a complete copy of the source tree.

Current plugin API version: `0.1`.

HAPI plugins are trusted local packages. Web parts are declarative descriptors; Hub and Runner parts execute local JavaScript in-process.

## Start here

- [Plugins guide](/guide/plugins) — architecture, first install loop, and safety model.
- [Manifest](./manifest.md) — the common `hapi.plugin.json` fields.
- [Runtimes](./runtimes.md) — Hub, Runner, and agent extension entry points.
- [Web descriptors](./web-descriptors.md) — UI descriptors rendered by HAPI Web.
- [Marketplace](./marketplace.md) — source-first marketplace flow.

## Machine-readable contracts

- [Admin API](./admin-api.md) — generated endpoint table.
- [OpenAPI JSON](/plugin-api/openapi.json)
- [JSON Schemas](./schemas.md)

## Source of truth

AI agents and maintainers should read the source for details instead of relying on long prose copies:

- `shared/src/plugins/sdk.ts` — runtime context and contribution types.
- `shared/src/plugins/manifest.ts` — manifest schema.
- `shared/src/plugins/admin.ts` — admin DTOs.
- `shared/src/plugins/marketplace.ts` — marketplace DTOs.
- `hub/src/plugins/` — Hub runtime, marketplace, install plans.
- `cli/src/runner/plugins/` — Runner runtime and spawn extension pipeline.
- `scripts/plugin-api-docs/schemaCatalog.ts` — generated schema index.
- `scripts/plugin-api-docs/endpointCatalog.ts` — generated OpenAPI endpoint index.

## What is generated?

Only stable contracts should be generated:

- `docs/public/plugin-api/openapi.json`
- `docs/public/plugin-api/schemas/*.json`
- `docs/reference/plugin-api/admin-api.md`
- `docs/reference/plugin-api/schemas.md`

Tutorials and conceptual docs are hand-written so they can stay short.
