---
description: Patterns for the shared protocol package
globs: shared/**
---

# Shared Protocol Package (`@hapi/protocol`)

## Schema Validation: Zod

- Define schemas in `schemas.ts`, infer types with `z.infer<typeof Schema>`
- Export types separately in `types.ts` for consumers who only need type checking
- Use discriminated unions for event types (`z.discriminatedUnion('type', [...])`)
- Use `.optional()` for forward-compatible fields, `.passthrough()` when extra fields are acceptable

## Exports Structure

```
@hapi/protocol           # Full protocol (index.ts)
@hapi/protocol/schemas   # Zod schemas for runtime validation
@hapi/protocol/types     # Type-only exports
@hapi/protocol/messages  # Message utilities
@hapi/protocol/modes     # Permission & model mode enums
@hapi/protocol/beads     # Bead/task types
```

## Cross-Package Conventions

- Runtime validation: import from `@hapi/protocol/schemas`
- Type checking only: import from `@hapi/protocol/types` or `@hapi/protocol`
- New fields should be `.optional()` to avoid breaking existing consumers
- Socket.IO type safety: use `ServerToClientEvents` / `ClientToServerEvents` interfaces
