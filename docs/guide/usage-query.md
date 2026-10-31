# Agent quota queries

HAPI can optionally query account quota windows for **Claude Code**, **Codex**,
and **Kimi CLI** through a selected Runner. The Web UI sends only the template and
receives sanitized percentages and reset timestamps; it never receives the
configured API key. The settings page lists only these Agents when the selected
machine reports them as installed and available.

## Data flow

```text
Web settings / session context popover
        ↓ authenticated Hub API
Hub machine-scoped RPC
        ↓ Socket.IO
Runner resolves local agent credentials and calls the provider
        ↓
Runner returns 5-hour / 7-day percentages and reset timestamps
```

The Runner keeps a five-minute in-memory cache. Opening the context popover only
triggers a new upstream request when the cache is expired. A failed refresh keeps
the last successful windows and observes a 30-second retry cooldown. The request
has a 10-second timeout and responses are capped at 2 MiB.

## Configure a template

Open **Settings → Agent quota queries**, choose an online machine and one of the
available Agents, then select a template. The editor is declarative JSON; it
supports:

- `{{baseUrl}}` — the selected Agent's configured endpoint;
- `{{baseOrigin}}` — the configured endpoint's scheme, host, and port, useful for
  provider adapters with canonical paths;
- `{{apiKey}}` — the selected Agent's configured credential;
- `GET` requests without a body only; quota templates are read-only. A provider
  that requires a mutating method, request body, or custom signature needs a
  reviewed Runner adapter;
- dot and numeric bracket paths such as `usage.resetTime` and
  `limits[0].detail.remaining`;
- direct percentages (`percentPath`) or `used`/`remaining` plus `limit`.

The built-in reviewed adapters cover Kimi Coding Plan, ZenMux subscription,
Zhipu GLM Coding Plan, and MiniMax Coding Plan. The generic and custom JSON-path
templates remain available for compatible providers.

Generic and custom templates use the JSON paths in their `fiveHour` and
`sevenDay` sections. Reviewed provider adapters use a fixed, audited parser for
their provider response shape; changing those path fields does not change the
reviewed adapter's parsing behavior.

The Runner only permits HTTPS endpoints (HTTP is allowed for loopback during
local development) and requires the request URL to keep the configured base
URL origin. API keys are rejected in URLs and are never included in results or
logs.

The first version resolves API-key style credentials from the Runner's process
environment and the standard Claude, Codex, and Kimi configuration files.
OAuth-only login state is intentionally not treated as an API key; it needs a
reviewed provider adapter in a later change. Kimi CLI credentials are resolved
from `KIMI_BASE_URL` / `KIMI_API_KEY` or the active provider in
`~/.kimi-code/config.toml`, falling back to the legacy `~/.kimi/config.toml`
(with the `KIMI_CODE_HOME` override).

Use **Test** before saving. A successful test returns sanitized `5H` and `7D`
values. After enabling and saving, open the session's context control to view
the same windows and live local reset countdowns.

## Kimi example

The built-in Kimi Coding Plan template uses the canonical Kimi Coding usage
endpoint:

```http
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer {{apiKey}}
```

It derives utilization from `limit` and `remaining` and reads `resetTime`. The
Kimi For Coding key is distinct from a Kimi Open Platform key; use the matching
endpoint and credential family.

Adding another provider should add a reviewed template or Runner adapter rather
than grant arbitrary code execution.

## Security boundary

Templates are not JavaScript programs. They cannot run shell commands, read
files, inspect environment variables, or send requests to a different origin.
For that reason, a provider requiring a custom signature, multi-step
authentication, or a mutating request needs a dedicated reviewed Runner adapter
in a later change.
