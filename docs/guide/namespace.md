# Namespace (Advanced)

Namespaces let a small team share one HAPI hub while keeping each member's sessions, machines, Web login, Telegram binding, notifications, and remote actions behind an independent credential.

This is an authorization boundary. A credential maps to exactly one namespace on the server; clients cannot choose a namespace by appending a suffix.

## Credential model

- `CLI_API_TOKEN` authenticates only the reserved `default` namespace.
- `HAPI_NAMESPACE_TOKENS_JSON` or `settings.json.namespaceTokens` maps every non-default namespace to a different opaque credential.
- Namespace names use 1–64 letters, numbers, dots, underscores, or hyphens. `default` is reserved.
- Every namespace credential must be at least 16 characters and must not duplicate the default or another namespace credential.

## Setup with environment variables

Configure the default credential and an independent credential for each team member:

```bash
export CLI_API_TOKEN="default-independent-token"
export HAPI_NAMESPACE_TOKENS_JSON='{
  "alice": "alice-independent-token",
  "bob": "bob-independent-token"
}'
```

Restart the hub after changing credentials. Alice uses only `alice-independent-token` in her CLI, Web login, and Telegram binding; Bob uses only `bob-independent-token`.

## Setup with settings.json

The equivalent `~/.hapi/settings.json` configuration is:

```json
{
  "cliApiToken": "default-independent-token",
  "namespaceTokens": {
    "alice": "alice-independent-token",
    "bob": "bob-independent-token"
  }
}
```

HAPI keeps `settings.json` at mode `0600` on POSIX systems because it contains credentials.

## Migration from legacy suffix tokens

Legacy `base-token:alice` suffixes are rejected. Before upgrading a shared hub:

1. Generate a new independent random credential for every namespace.
2. Configure the server-side mapping.
3. Replace the token in each member's separate `HAPI_HOME` and Web login.
4. Restart the hub. The schema-v16 migration deliberately invalidates every pre-v16 Telegram binding because those rows cannot prove which credential authorized the namespace.
5. Have each Telegram user open the Mini App and bind again with the current independent credential for their namespace.
6. Verify each member sees only their own namespace.

Do not derive member credentials from the default token or reuse one credential in multiple namespaces.

Rotating or removing a namespace credential also invalidates its persisted Telegram bindings for fresh Web JWTs, bot callbacks, and notifications. Rebind with the current credential after a rotation. Rotating the JWT secret invalidates every Telegram binding fingerprint as well, so all Telegram users must rebind. Existing Web JWTs otherwise expire on their normal four-hour schedule.

## Operational notes

- One machine ID cannot be reused across namespaces. Use a separate `HAPI_HOME` per namespace, or run `hapi auth logout` before switching.
- Remote spawn is namespace-scoped. For several namespaces on one machine, run a separate runner and `HAPI_HOME` for each namespace.
- Removing a mapping prevents new logins and CLI connections and disables fresh Telegram authentication, callbacks, and notifications for that namespace. Existing Web JWTs expire after four hours; rotate the JWT secret as well if immediate Web-session invalidation is required.
