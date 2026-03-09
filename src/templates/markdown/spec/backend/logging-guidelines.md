# Logging Guidelines

> How logging is done in this project.

---

## Overview

HAPI Hub uses **simple console logging** (no logging library). Logs are written to stdout/stderr and captured by the process manager or container runtime.

**Key characteristics**:
- `console.log()` for informational messages
- `console.warn()` for warnings (configuration issues, deprecations)
- `console.error()` for errors (unexpected failures, exceptions)
- Prefix format: `[Component] Message`
- Startup logs show configuration sources
- No structured logging (plain text)

**Philosophy**: Simple, readable logs for development and debugging. Production deployments can capture and process stdout/stderr.

---

## Log Levels

### `console.log()` - Informational

Use for:
- **Startup messages** - Server starting, configuration loaded
- **Service status** - "Tunnel: ready", "Push: enabled"
- **Important state changes** - "Session resumed", "Machine connected"
- **User-facing events** - QR code display, URLs to open

```typescript
console.log('HAPI Hub starting...')
console.log('[Hub] HAPI_LISTEN_PORT: 3000 (environment)')
console.log('[Web] Hub listening on :3000')
console.log('HAPI Hub is ready!')
```

**Format**: `[Component] Message` or plain message for startup banners.

### `console.warn()` - Warnings

Use for:
- **Configuration issues** - Weak tokens, invalid settings
- **Deprecation notices** - Old API usage
- **Non-fatal errors** - Failed to parse optional config, fallback used
- **Security concerns** - Weak secrets detected

```typescript
console.warn('[WARN] CLI_API_TOKEN appears to be weak. Consider using a stronger secret.')
console.warn(`[WARN] CLI_API_TOKEN from ${source} contains ":" but is not a valid token.`)
console.error(`[WARN] Failed to parse ${settingsFile}: ${error}`)  // Note: uses console.error for visibility
```

**Format**: `[WARN] Message` or `[Component] Warning message`.

### `console.error()` - Errors

Use for:
- **Unexpected errors** - Exceptions, database errors, network failures
- **Fatal errors** - Server cannot start, critical dependency missing
- **Background task failures** - Notification send failed, sync error
- **Service failures** - Tunnel failed to start, push notification error

```typescript
console.error('Fatal error:', error)
console.error('[Tunnel] Failed to start:', error instanceof Error ? error.message : error)
```

**Format**: `[Component] Error message` with error object/message.

---

## Logging Patterns

### Startup Configuration Logging

Log all configuration on startup with source information:

```typescript
console.log('HAPI Hub starting...')
console.log(`[Hub] HAPI_LISTEN_HOST: ${config.listenHost} (${formatSource(config.sources.listenHost)})`)
console.log(`[Hub] HAPI_LISTEN_PORT: ${config.listenPort} (${formatSource(config.sources.listenPort)})`)
console.log(`[Hub] HAPI_PUBLIC_URL: ${config.publicUrl} (${formatSource(config.sources.publicUrl)})`)
```

**Why**: Makes debugging configuration issues easy - you can see where each value came from.

### Component Prefixes

Use consistent prefixes for different components:

- `[Hub]` - Main hub process, configuration
- `[Web]` - HTTP server, API routes
- `[Socket]` - Socket.IO server
- `[Store]` - Database operations (rare - only for migrations)
- `[Tunnel]` - WireGuard tunnel management
- `[WARN]` - Warnings from any component

```typescript
console.log('[Web] Hub listening on :3000')
console.log('[Socket] Client connected: machine-123')
console.log('[Tunnel] Tunnel ready')
```

### Error Logging

Always log unexpected errors with context:

```typescript
try {
    await notificationHub.notify(event)
} catch (error) {
    console.error('Failed to send notification:', error)
    // Don't rethrow - background service continues
}
```

**Include**:
- What operation failed
- The error object (for stack trace)
- Relevant context (session ID, machine ID, etc.)

**Don't include**:
- Sensitive data (tokens, passwords)
- Full request bodies (may contain PII)

### Conditional Logging

Don't log expected events in normal operation:

```typescript
// Bad - too noisy
socket.on('message', (data) => {
    console.log('Received message:', data)  // Logs every message
})

// Good - only log errors
socket.on('message', (data) => {
    const parsed = messageSchema.safeParse(data)
    if (!parsed.success) {
        // Silent ignore - invalid events are expected from buggy clients
        return
    }
    // Process message without logging
})
```

**Log sparingly**: Only log state changes, errors, and important events. Don't log every request/message.

---

## What to Log

### ✅ Always Log

1. **Startup events**
   - Server starting
   - Configuration loaded (with sources)
   - Services initialized (tunnel, push, etc.)
   - Server ready (with URLs)

2. **Configuration issues**
   - Weak secrets detected
   - Invalid settings (with fallback)
   - Missing optional config

3. **Service state changes**
   - Tunnel connected/disconnected
   - Push notification service started/stopped
   - Database migrations applied

4. **Unexpected errors**
   - Exceptions in background tasks
   - Database errors
   - Network failures
   - Service initialization failures

5. **Security events**
   - Weak token warnings
   - Authentication failures (rate-limited)

### ❌ Never Log

1. **Secrets and tokens**
   ```typescript
   // Bad - leaks secret
   console.log('JWT secret:', jwtSecret)

   // Good - log that it exists
   console.log('[Hub] JWT secret: loaded from file')
   ```

2. **Full request/response bodies**
   ```typescript
   // Bad - may contain PII
   console.log('Request body:', req.body)

   // Good - log validation failure
   console.error('Invalid request body: missing required field "name"')
   ```

3. **User data / PII**
   - User IDs (use generic "user" or hash)
   - Email addresses
   - IP addresses (unless for security events)
   - Message content

4. **High-frequency events**
   ```typescript
   // Bad - logs every message
   socket.on('message', (data) => {
       console.log('Message received')
   })

   // Good - only log errors
   socket.on('message', (data) => {
       if (!valid(data)) {
           console.error('Invalid message format')
       }
   })
   ```

5. **Expected validation failures**
   - 400 Bad Request (user sent invalid input)
   - 404 Not Found (expected in normal operation)
   - 401 Unauthorized (expected when not logged in)

---

## Formatting Guidelines

### Message Format

```typescript
// Component prefix + message
console.log('[Hub] Server starting...')
console.log('[Web] Listening on :3000')

// Warning prefix
console.warn('[WARN] Weak token detected')

// Error with context
console.error('[Tunnel] Failed to connect:', error)
```

### Multi-line Output

For banners and structured output:

```typescript
console.log('')
console.log('='.repeat(70))
console.log('  NEW CLI_API_TOKEN GENERATED')
console.log('='.repeat(70))
console.log('')
console.log(`  Token: ${config.cliApiToken}`)
console.log('')
console.log(`  Saved to: ${config.settingsFile}`)
console.log('')
console.log('='.repeat(70))
console.log('')
```

### Error Objects

Always include the error object for stack traces:

```typescript
// Good - includes stack trace
console.error('Operation failed:', error)

// Bad - loses stack trace
console.error('Operation failed:', error.message)

// Good - check if Error instance
console.error('[Tunnel] Failed:', error instanceof Error ? error.message : error)
```

---

## Production Considerations

### Log Capture

In production, logs are captured by:
- **Docker**: `docker logs <container>`
- **systemd**: `journalctl -u hapi-hub`
- **PM2**: `pm2 logs`

### Log Rotation

Not handled by the application - use external tools:
- Docker: `--log-opt max-size=10m --log-opt max-file=3`
- systemd: Automatic with journald
- PM2: Built-in log rotation

### Sensitive Data

**Never log**:
- `CLI_API_TOKEN` value (log source only)
- `JWT_SECRET` value
- User message content
- Database connection strings with passwords

**Safe to log**:
- Configuration sources ("environment", "file", "default")
- Service status ("enabled", "disabled")
- Non-sensitive config values (port, host, public URL)

---

## Common Mistakes

- ❌ Logging secrets or tokens
- ❌ Logging every request/message (too noisy)
- ❌ Not logging unexpected errors
- ❌ Logging error.message instead of error object (loses stack trace)
- ❌ Using console.log for errors (use console.error)
- ❌ Not including component prefix
- ❌ Logging PII (user IDs, emails, message content)
- ❌ Not logging configuration sources on startup
- ❌ Logging expected validation failures (400s, 404s)

---

## Best Practices

- ✅ Use component prefixes (`[Hub]`, `[Web]`, `[Socket]`)
- ✅ Log configuration on startup with sources
- ✅ Log unexpected errors with context
- ✅ Include error objects for stack traces
- ✅ Use `console.error` for errors, `console.warn` for warnings
- ✅ Keep logs concise and actionable
- ✅ Log state changes, not every event
- ✅ Never log secrets, tokens, or PII
- ✅ Use `error instanceof Error` check before accessing `.message`
- ✅ Log what failed, not just "error occurred"
