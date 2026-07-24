# API providers

HAPI can manage machine-local API provider profiles for Claude Code, Codex, and Grok Build. Profiles select a protocol, credentials, endpoint, and models for one Agent on one runner machine.

## Configure a profile

Open **Settings → API Providers**, choose a machine, then choose an Agent. Add a profile with:

- a display name;
- an Agent-compatible API protocol;
- an optional API base URL;
- an API key, or a Claude-specific auth token;
- an optional default model and custom model entries.

The selected protocol is validated against the Agent. Claude Code supports the Anthropic Messages protocol. Codex supports OpenAI Responses and OpenAI Chat Completions. Grok Build supports OpenAI Chat Completions.

Profiles and secrets are stored only on the selected machine in `$HAPI_HOME/providers.json` with private file permissions. The Hub does not persist provider secrets, profile list responses never return them, and secrets are injected only into the selected Agent process.

## Check a provider and choose models

Use **Test** to check the profile and refresh its available model list. A failed check does not discard the form, so a profile can be saved as unverified and retried later.

Native Agent models and provider models are available while starting compatible sessions. You can also add a custom model. A model normally represents a 200K context window. To declare 1M context support, enable it for that model in the profile editor or append `[1M]` to the model name:

```text
example-model
example-model[1M]
```

This creates a normal 200K choice and a 1M choice. The suffix is only a HAPI selection marker; the provider receives the base model ID.

## Choose when it applies

Set a machine default to use a profile whenever that Agent starts on the selected machine. **Machine default** uses that profile when one is configured and otherwise falls back to the Agent's existing login. **System / agent login** always bypasses managed profiles and uses the Agent's existing login and environment.

You can override the choice while creating a session. A running session can select models that its Agent exposes; applying another provider requires a new or restarted session.

Terminal launches use the machine default too. Override it without exposing credentials in command history:

```bash
hapi --hapi-provider <profile-uuid>
hapi codex --hapi-provider <profile-uuid>
hapi grok --hapi-provider <profile-uuid>
```

Use `--hapi-provider system` to bypass the managed default.

## Security

- Never place credentials in an API URL.
- Provider list and health-check responses redact secrets.
- Use HTTPS for remote endpoints when possible.
- Keep the selected runner machine and its `$HAPI_HOME` directory protected.
