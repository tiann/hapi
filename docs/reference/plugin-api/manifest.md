# Plugin manifest

`hapi.plugin.json` is the cold-path contract. HAPI validates it before importing runtime code.

For the exact schema, use [PluginManifestLite](/plugin-api/schemas/plugin-manifest.schema.json).

## Minimal manifest

```json
{
    "id": "com.example.my-plugin",
    "name": "My Plugin",
    "version": "0.1.0",
    "pluginApiVersion": "0.1"
}
```

## Common fields

| Field | Purpose |
|---|---|
| `id` | Stable plugin id, usually reverse-DNS style. |
| `name` | Human-readable name. |
| `version` | Full SemVer plugin package version. |
| `pluginApiVersion` | HAPI plugin API contract version. |
| `runtimes` | Hub and/or Runner JavaScript entries. |
| `contributions` | Static descriptors and declared extension contributions. |
| `capabilities` | User-facing feature grouping across Web, Hub, Runner parts. |
| `config` | Non-secret config metadata. |
| `permissions` | Network and secret declarations. |
| `compatibility` | HAPI, plugin API, OS/arch, and extension-point constraints. |
| `install` | Install-plan target-selection hints. |

## Positions

| Position | Manifest signal | Runs plugin JS? |
|---|---|---:|
| Web | `contributions.web` or `capabilities[].parts.web` | no |
| Hub | `runtimes.hub`, `contributions.hub`, or Hub capability parts | yes |
| Runner | `runtimes.runner`, `contributions.runner`, agent contributions, or Runner capability parts | yes |

Web descriptors install on the Hub and are rendered by Web. Web does not execute plugin JavaScript.

## Permissions

```json
{
    "permissions": {
        "network": ["https://api.example.com/*"],
        "secrets": ["EXAMPLE_API_TOKEN"]
    }
}
```

- `permissions.network` is checked by `ctx.network.fetch`.
- `permissions.secrets` lists environment variables readable through `ctx.secrets.get(name)`.
- Permissions are declarations and SDK checks, not a sandbox boundary.

## Compatibility pattern

```json
{
    "pluginApiVersion": "0.1",
    "compatibility": {
        "pluginApi": ">=0.1 <0.2"
    }
}
```

Use runtime-specific compatibility only when a plugin depends on a specific Hub or Runner extension point.
