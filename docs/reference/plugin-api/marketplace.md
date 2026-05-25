# Plugin marketplace

The marketplace is source-first for this MVP. First-party marketplace entries point at source directories under `plugins/<id>` and are packaged on demand after validation.

## Flow

```text
plugins/<id>/hapi.plugin.json
plugins/<id>/hapi.marketplace.json
        │
        ▼
bun run marketplace:generate
        │
        ├─ shared/src/plugins/marketplaceSources.generated.ts
        └─ marketplace/catalog.v1.json
```

Users install through an install plan:

```text
catalog entry → compatible release → install plan → review targets → execute
```

## Developer commands

```bash
bun run marketplace:generate
bun run marketplace:check
```

`marketplace:check` verifies generated catalog drift, schema validity, and packaging hygiene.

## Trust model

- Local catalog/package paths are disabled by default unless explicitly allowed for trusted development.
- Remote catalog/package URLs must use HTTPS by default.
- Remote source catalogs need an explicit trusted source root or embedded source metadata.
- Package and source checksums are verified before installation.

## Contracts

- [PluginMarketplaceCatalog](/docs/plugin-api/schemas/plugin-marketplace-catalog.schema.json)
- [PluginMarketplaceListResponse](/docs/plugin-api/schemas/plugin-marketplace-list-response.schema.json)
- [PluginMarketplaceInstallRequest](/docs/plugin-api/schemas/plugin-marketplace-install-request.schema.json)
- [PluginMarketplaceInstallPlanResponse](/docs/plugin-api/schemas/plugin-marketplace-install-plan-response.schema.json)
