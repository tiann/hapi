# HAPI plugin marketplace metadata

This directory is reserved for generated marketplace catalog metadata only.

Rules:

- Do not commit installable plugin archives (`.tgz`, `.tar.gz`, `.zip`).
- Do not commit plugin source trees with `hapi.plugin.json`, `dist/`, or `node_modules/`.
- First-party marketplace plugin source lives under `plugins/<plugin-id>/`.
- `catalog.v1.json` is generated from `plugins/*/hapi.plugin.json` and `plugins/*/hapi.marketplace.json`; do not edit it by hand.
- Validate catalog changes with `bun run marketplace:check`.
- Release builds run `bun run marketplace:check` to validate metadata and fail if marketplace plugin artifacts would be bundled.

Contribution path:

1. Add or edit a source plugin under `plugins/<plugin-id>/`.
2. Update `hapi.plugin.json` and `hapi.marketplace.json`.
3. Run `bun run marketplace:generate`.
4. Run `bun run marketplace:check` before opening a PR.

External GitHub Release package entries remain supported by the schema for future ecosystem use, but the initial built-in marketplace is source-first.

Reference: `docs/reference/plugin-api/marketplace.md`.
