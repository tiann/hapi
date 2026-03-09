# Type Safety

> Type safety patterns in this project.

---

## Overview

HAPI Web uses **TypeScript in strict mode** with comprehensive type coverage. Types are centralized in `types/` directory and imported via path aliases. The project emphasizes:

- **Strict TypeScript** (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`)
- **Shared protocol types** from `@hapi/protocol` workspace package
- **Type-only imports** for better tree-shaking
- **No runtime validation** on frontend (validation happens on backend)
- **Explicit null handling** (no implicit undefined)

---

## Type Organization

### Shared Types (`types/api.ts`)

All API-related types live in `types/api.ts`:

```typescript
// Re-export types from shared protocol package
export type {
    AgentState,
    AttachmentMetadata,
    Session,
    SessionSummary,
} from '@hapi/protocol/types'

// Frontend-specific extensions
export type DecryptedMessage = ProtocolDecryptedMessage & {
    status?: MessageStatus
    originalText?: string
}

// API response types
export type SessionsResponse = { sessions: SessionSummary[] }
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        beforeSeq: number | null
        nextBeforeSeq: number | null
        hasMore: boolean
    }
}
```

**Pattern**: Import from protocol, extend as needed, define response shapes.

### Local Types

Component-specific types are defined in the same file:

```typescript
// components/Spinner.tsx
type SpinnerProps = {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string | null
}
```

**When to use local types**:
- Props types for components
- Internal state types
- Types only used in one file

**When to use shared types**:
- API data structures
- Types used across multiple files
- Domain models (Session, Message, Machine)

### Type-Only Imports

Always use `type` keyword for type-only imports:

```typescript
// Good - explicit type import
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'

// Bad - value import for types
import { SessionSummary } from '@/types/api'
```

**Why**: Better tree-shaking, clearer intent, faster compilation.

---

## Validation

### No Frontend Validation

Frontend does **not** perform runtime validation. All validation happens on the backend.

**Rationale**:
- Backend is the source of truth
- Avoids duplication
- Frontend trusts API responses (authenticated, encrypted connection)

### Type Assertions (Minimal)

Type assertions are rare and only used for:

1. **External library types** that are incorrect
2. **JSON parsing** where structure is known

```typescript
// Acceptable - parsing known structure
const payload = JSON.parse(decoded) as { exp?: unknown }

// Acceptable - library metadata typing
const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
```

**Never** use `as any` or `as unknown as T` without good reason.

---

## Common Patterns

### Discriminated Unions

Use discriminated unions for variant types:

```typescript
// Good - discriminated union
export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

// Usage with type narrowing
if (response.type === 'success') {
    console.log(response.sessionId)  // TypeScript knows this exists
}
```

### Optional vs Nullable

- Use `?` for optional properties (may be absent)
- Use `| null` for nullable properties (explicitly null)

```typescript
type SessionMetadata = {
    path: string           // Required
    version?: string       // Optional (may be absent)
    flavor: string | null  // Nullable (explicitly null or string)
}
```

### Function Types

Use arrow function syntax for function types:

```typescript
// Good
type OnRetry = (localId: string) => void
type OnLoadMore = () => Promise<unknown>

// Bad - verbose
type OnRetry = { (localId: string): void }
```

### Generic Constraints

Use generic constraints for reusable utilities:

```typescript
// From lib/utils.ts
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs))
}
```

### Type Guards

Create type guards for runtime type checking:

```typescript
function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}
```

### Const Assertions

Use `as const` for literal types:

```typescript
// Query keys with const assertion
export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (id: string) => ['session', id] as const,
}
```

---

## TypeScript Configuration

### Web (`web/tsconfig.json`)

```json
{
    "extends": "../tsconfig.base.json",
    "compilerOptions": {
        "target": "ES2020",
        "lib": ["ES2020", "ESNext", "ESNext.Disposable", "DOM", "DOM.Iterable"],
        "jsx": "react-jsx",
        "noEmit": true,
        "types": ["vite/client"],
        "baseUrl": ".",
        "paths": {
            "@/*": ["./src/*"]
        }
    },
    "include": ["src"]
}
```

### Base (`tsconfig.base.json`)

```json
{
    "compilerOptions": {
        "target": "ESNext",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "lib": ["ES2022"],
        "strict": true,
        "noImplicitAny": true,
        "strictNullChecks": true,
        "noImplicitReturns": true,
        "skipLibCheck": true,
        "resolveJsonModule": true
    }
}
```

**Key settings**:
- `strict: true` - All strict checks enabled
- `noImplicitAny: true` - No implicit any types
- `strictNullChecks: true` - Explicit null/undefined handling
- `noImplicitReturns: true` - All code paths must return

---

## Handling External Data

### API Responses

Trust API response types (backend validates):

```typescript
export class ApiClient {
    async getSessions(): Promise<SessionsResponse> {
        const response = await this.fetch('/api/sessions')
        return await response.json() as SessionsResponse
    }
}
```

### Unknown Types

Use `unknown` instead of `any` for truly unknown data:

```typescript
// Good - forces type checking
function parseError(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return 'Unknown error'
}

// Bad - bypasses type checking
function parseError(error: any): string {
    return error.message  // No type safety
}
```

---

## Forbidden Patterns

### ❌ Don't Use `any`

```typescript
// Bad
function handleData(data: any) {
    return data.value
}

// Good
function handleData(data: unknown) {
    if (typeof data === 'object' && data !== null && 'value' in data) {
        return (data as { value: unknown }).value
    }
}
```

### ❌ Don't Use Non-Null Assertions Carelessly

```typescript
// Bad - assumes element exists
const element = document.getElementById('root')!

// Good - handle null case
const element = document.getElementById('root')
if (!element) throw new Error('Root element not found')
```

### ❌ Don't Ignore TypeScript Errors

```typescript
// Bad
// @ts-ignore
const value = data.unknownProperty

// Good - fix the type or use proper type guard
const value = 'unknownProperty' in data ? data.unknownProperty : undefined
```

### ❌ Don't Use `interface` for Props

```typescript
// Bad - use type instead
interface ButtonProps {
    onClick: () => void
}

// Good
type ButtonProps = {
    onClick: () => void
}
```

**Why**: `type` is more flexible (unions, intersections) and consistent with the codebase.

---

## Common Mistakes

- ❌ Using `any` instead of `unknown`
- ❌ Not using `type` keyword for type-only imports
- ❌ Using `interface` instead of `type` for props
- ❌ Ignoring TypeScript errors with `@ts-ignore`
- ❌ Using non-null assertions (`!`) without null checks
- ❌ Not handling `null` and `undefined` explicitly
- ❌ Defining types inline instead of extracting them
- ❌ Not using discriminated unions for variant types
- ❌ Using `as any` for type coercion
- ❌ Not leveraging type inference (over-annotating)

---

## Best Practices

- ✅ Use `type` for all type definitions
- ✅ Use `type` keyword for type-only imports
- ✅ Handle `null` and `undefined` explicitly
- ✅ Use discriminated unions for variants
- ✅ Use `unknown` for truly unknown data
- ✅ Create type guards for runtime checks
- ✅ Use `as const` for literal types
- ✅ Leverage type inference (don't over-annotate)
- ✅ Keep types close to usage (local types in same file)
- ✅ Share types via `types/api.ts` when needed across files
