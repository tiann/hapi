# Web descriptors

Web descriptors are JSON UI descriptions. HAPI Web renders them with built-in primitives; it does not execute plugin JavaScript in the browser.

## Where descriptors appear

| Contribution | UI surface |
|---|---|
| `settingsPanels` | Settings → Plugins detail page |
| `badges` | Plugin lists and detail metadata |
| `actions` | Plugin management actions |
| `composerActions` | Chat composer buttons/actions |
| `newSessionFields` | New Session form fields |

## Common primitives

| Primitive | Use |
|---|---|
| `text` | Static explanatory text. |
| `badge` | Status or metadata marker. |
| `table` | Small read-only data tables. |
| `actionButton` | Built-in management action trigger. |
| `schemaForm` | Config form using typed fields. |
| `delayPicker` | Composer UI for delayed message delivery. |
| `runnerSpawnDefaultsEditor` | Runner spawn-defaults config editor. |

## Minimal settings panel

```json
{
    "contributions": {
        "web": {
            "settingsPanels": [
                {
                    "id": "example-settings",
                    "title": "Example Plugin",
                    "components": [
                        { "kind": "text", "text": "Descriptor-only UI." }
                    ]
                }
            ]
        }
    }
}
```

For exact shapes, use [PluginWebContributions](/docs/plugin-api/schemas/plugin-web-contributions.schema.json).
