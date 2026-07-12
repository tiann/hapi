# Grok Build

HAPI can run the official Grok Build CLI locally and control the same coding session remotely from the Web/PWA.

## Install

Install Grok Build using the official installer:

::: code-group

```bash [macOS / Linux / WSL]
curl -fsSL https://x.ai/cli/install.sh | bash
```

```powershell [Windows PowerShell]
irm https://x.ai/cli/install.ps1 | iex
```

:::

Verify the installation:

```bash
grok version
```

## Authenticate

HAPI reuses the Grok CLI's local authentication. On a headless runner machine, authenticate once with device-code login:

```bash
grok login --device-auth
```

Alternatively, configure an xAI API key in the runner environment:

```bash
export XAI_API_KEY="xai-..."
```

Do not place API keys in HAPI configuration files, logs, or a repository.

## Start a session

Start the native Grok Build TUI:

```bash
hapi grok
```

Start with explicit launch settings:

```bash
hapi grok --model grok-4.5 --effort low --permission-mode default
```

Sessions created from a HAPI runner start in remote mode automatically. Terminal-created sessions start in the native Grok TUI and can switch to remote control without parsing terminal output.

## Permission modes

HAPI exposes a conservative subset for the first integration:

- `default` — tool requests are shown in HAPI for approval or denial.
- `plan` — HAPI asks Grok to plan only and rejects tool execution requests.
- `bypassPermissions` — tool requests are automatically approved for the session.

Use `bypassPermissions` only in a trusted workspace.

## Resume and handoff

Remote mode uses Grok's ACP stdio agent (`grok agent stdio`). HAPI stores the native Grok session ID and uses it for:

- ACP `session/load` after a restart.
- `grok --resume <session-id>` when switching back to the native TUI.
- `hapi resume <hapi-session-id>` from a terminal.

For a new local session, HAPI supplies a UUID with `grok --session-id`, so the session can be resumed without scraping the fullscreen TUI.

## Model and effort controls

The Create page discovers Grok's ACP model catalog and the reasoning-effort choices advertised for each model. Remote sessions can switch both model and effort between turns; HAPI applies them through ACP `session/set_model` and `session/set_mode`.

HAPI also exposes Grok's common slash commands, discovers skills from `.grok/skills`, `~/.grok/skills`, and shared `.agents/skills`, and asks Grok to set a concise HAPI session title after the first normal prompt.

## Current limitations

- OAuth/device-code login must be completed outside the HAPI Web UI.
- Grok subscription, credit, and model availability are controlled by xAI.

If a remote session reports authentication failure, run `grok login --device-auth` on the runner machine and retry.
