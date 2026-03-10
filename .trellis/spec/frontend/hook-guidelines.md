# Hook Guidelines

> How hooks are used in this project.

---

## Overview

HAPI Web uses React hooks extensively for state management and side effects. Custom hooks encapsulate business logic, keeping components focused on presentation. Data fetching uses TanStack Query (React Query) with a clear separation between queries and mutations.

**Key patterns**:
- Custom hooks for reusable logic (platform detection, clipboard, auth)
- TanStack Query for server state (queries in `hooks/queries/`, mutations in `hooks/mutations/`)
- Ref-based patterns for stable callbacks and avoiding stale closures
- Non-hook utilities exported alongside hooks when needed

---

## Custom Hook Patterns

### Basic Custom Hook

```typescript
// hooks/useCopyToClipboard.ts
import { useState, useCallback } from 'react'
import { usePlatform } from './usePlatform'
import { safeCopyToClipboard } from '@/lib/clipboard'

export function useCopyToClipboard(resetDelay = 1500) {
    const [copied, setCopied] = useState(false)
    const { haptic } = usePlatform()

    const copy = useCallback(async (text: string) => {
        try {
            await safeCopyToClipboard(text)
            haptic.notification('success')
            setCopied(true)
            setTimeout(() => setCopied(false), resetDelay)
            return true
        } catch {
            haptic.notification('error')
            return false
        }
    }, [haptic, resetDelay])

    return { copied, copy }
}
```

Key aspects:
1. Named export (not default)
2. Return object with descriptive keys
3. Use `useCallback` for returned functions
4. Accept configuration parameters with defaults

### Hook + Non-Hook Utility Pattern

When logic needs to be used both inside and outside React components, export both:

```typescript
// hooks/usePlatform.ts
export function usePlatform(): Platform {
    const isTouch = useMemo(
        () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
        []
    )
    return { isTouch, haptic }
}

// Non-hook version for use outside React components
export function getPlatform(): Platform {
    const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    return { isTouch, haptic }
}
```

### Ref-Based Stable Callbacks

For complex hooks with many dependencies, use refs to avoid stale closures:

```typescript
// From hooks/useAuth.ts
export function useAuth(authSource: AuthSource | null, baseUrl: string) {
    const [token, setToken] = useState<string | null>(null)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)

    // Keep ref in sync with state
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const refreshAuth = useCallback(async (options?: { force?: boolean }) => {
        const currentSource = authSourceRef.current  // Read from ref, not closure
        const currentToken = tokenRef.current
        // ... implementation
    }, [baseUrl])  // Minimal dependencies

    return { token, api, refreshAuth }
}
```

**Why**: Avoids recreating callbacks on every render while ensuring they always read fresh values.

---

## Data Fetching

### TanStack Query Structure

Data fetching is organized into:
- `hooks/queries/` - Read operations (GET requests)
- `hooks/mutations/` - Write operations (POST/PUT/DELETE requests)

### Query Hook Pattern

```typescript
// hooks/queries/useSessions.ts
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useSessions(api: ApiClient | null): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getSessions()
        },
        enabled: Boolean(api),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
```

Key aspects:
1. Accept `ApiClient | null` to handle unauthenticated state
2. Use centralized `queryKeys` from `lib/query-keys.ts`
3. Return normalized shape (data, loading, error, refetch)
4. Provide default values for data (e.g., `?? []`)
5. Use `enabled` to prevent queries when dependencies are missing

### Mutation Hook Pattern

```typescript
// hooks/mutations/useSendMessage.ts
import { useMutation } from '@tanstack/react-query'
import { usePlatform } from '@/hooks/usePlatform'

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    sendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
    retryMessage: (localId: string) => void
    isSending: boolean
} {
    const { haptic } = usePlatform()

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) throw new Error('API unavailable')
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments)
        },
        onMutate: async (input) => {
            // Optimistic update
            appendOptimisticMessage(input.sessionId, optimisticMessage)
        },
        onSuccess: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'sent')
            haptic.notification('success')
        },
        onError: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'failed')
            haptic.notification('error')
        },
    })

    const sendMessage = (text: string, attachments?: AttachmentMetadata[]) => {
        if (!api || !sessionId) {
            options?.onBlocked?.(/* reason */)
            haptic.notification('error')
            return
        }
        mutation.mutate({ sessionId, text, localId: makeClientSideId('local'), createdAt: Date.now(), attachments })
    }

    return {
        sendMessage,
        retryMessage,
        isSending: mutation.isPending,
    }
}
```

Key aspects:
1. Use `onMutate` for optimistic updates
2. Use `onSuccess`/`onError` for side effects (haptic feedback, status updates)
3. Wrap mutation in user-friendly functions (`sendMessage`, not `mutate`)
4. Guard against missing dependencies (api, sessionId)
5. Provide callback options for flexibility

### Query Keys

Centralize query keys in `lib/query-keys.ts`:

```typescript
export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (id: string) => ['session', id] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
}
```

**Why**: Ensures consistency and makes invalidation easier.

---

## Naming Conventions

### Hook Names

- Always prefix with `use` (e.g., `useAuth`, `useSessions`)
- Use descriptive names that indicate purpose (e.g., `useCopyToClipboard`, not `useClipboard`)
- Query hooks: `use<Resource>` or `use<Resource>s` (e.g., `useSessions`, `useSession`)
- Mutation hooks: `use<Action><Resource>` (e.g., `useSendMessage`, `useSpawnSession`)

### File Names

- Match hook name: `useAuth.ts`, `useSessions.ts`
- One hook per file (unless closely related helpers)
- Place in appropriate directory:
  - `hooks/` - General custom hooks
  - `hooks/queries/` - TanStack Query read operations
  - `hooks/mutations/` - TanStack Query write operations
  - `realtime/hooks/` - Real-time connection hooks

### Return Values

Return objects with descriptive keys, not arrays:

```typescript
// Good
return { sessions, isLoading, error, refetch }

// Bad - unclear what each position means
return [sessions, isLoading, error, refetch]
```

---

## Common Patterns

### Cleanup and Cancellation

Always clean up side effects:

```typescript
useEffect(() => {
    let isCancelled = false

    async function run() {
        const result = await fetchData()
        if (isCancelled) return  // Don't update state if unmounted
        setData(result)
    }

    run()

    return () => { isCancelled = true }
}, [])
```

### Stable Event Listeners

Use refs for stable event listeners:

```typescript
useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleScroll = () => {
        // Read from refs, not closure
        const isNearBottom = /* ... */
        if (isNearBottom !== atBottomRef.current) {
            atBottomRef.current = isNearBottom
            onAtBottomChangeRef.current(isNearBottom)
        }
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
}, [])  // Stable: no dependencies, reads from refs
```

### Conditional Queries

Use `enabled` to prevent queries when dependencies are missing:

```typescript
const query = useQuery({
    queryKey: queryKeys.session(sessionId),
    queryFn: async () => api.getSession(sessionId),
    enabled: Boolean(api) && Boolean(sessionId),  // Only run when both exist
})
```

---

## Scenario: Session header Git status (cross-layer contract)

### 1. Scope / Trigger

- Trigger: Added/updated Git status summary rendered in session header and fetched through query hook.
- Why code-spec depth is required:
  - Cross-layer data flow: backend Git RPC -> API client methods -> query hook -> SessionChat -> SessionHeader.
  - Contract-sensitive UI states: loading/unavailable/normal must remain stable during refetch.

### 2. Signatures

- Query hook signature:

```typescript
useGitStatusFiles(api: ApiClient | null, sessionId: string | null): {
  status: GitStatusFiles | null
  error: string | null
  isLoading: boolean
}
```

- API client signatures consumed by the hook:

```typescript
api.getGitStatus(sessionId: string): Promise<GitStatus>
api.getGitDiffNumstat(sessionId: string): Promise<GitDiffNumstat>
```

- Header props contract:

```typescript
gitSummary?: Pick<GitStatusFiles, 'branch' | 'totalStaged' | 'totalUnstaged'> | null
gitLoading?: boolean
gitError?: boolean
```

### 3. Contracts

- Request preconditions:
  - `api` and `sessionId` must both be non-null before query execution.
  - If either is missing, the hook must not perform network calls.

- Response contract (normalized for header):
  - `branch: string | null` (`null` means detached state, must render localized detached label)
  - `totalStaged: number` (>= 0)
  - `totalUnstaged: number` (>= 0)

- UI text contract:
  - All status labels must come from i18n keys:
    - `session.git.staged`
    - `session.git.unstaged`
    - `session.git.loading`
    - `session.git.unavailable`
    - `session.git.detached`

- Boundary contract (anti-flicker):
  - Keep last successful `GitStatusFiles` in a ref.
  - During refetch, prefer cached status over transient loading/error display.

### 4. Validation & Error Matrix

- `api === null || sessionId === null` -> query disabled, no request, header Git block hidden or remains in non-loading state.
- Hook request in-flight and no cached status -> show loading UI.
- Hook request fails and no cached status -> show unavailable UI.
- Hook request fails but cached status exists -> continue showing cached normal state (no unavailable flicker).
- Session identity changes (`session.id`) -> cached git summary must be reset before evaluating loading/error fallback, so previous session status/error never leaks into new session header.
- `branch === null` -> show detached label (not empty string).
- `session.metadata.path` missing -> do not render Git status block in header.

### 5. Good/Base/Bad Cases

- Good:
  - Session path points to dirty repo, branch is `main`, staged/unstaged counters render with localized labels.
- Base:
  - Session path points to clean repo, counters show `0` and branch still renders.
- Bad:
  - Session path exists but transient refetch error replaces existing summary with `Git unavailable` (flicker regression).

### 6. Tests Required

- Unit (hook-level):
  - Assert `useGitStatusFiles` returns normalized totals and branch from combined API data.
  - Assert query does not execute when `api` or `sessionId` is missing.
- Component (SessionHeader):
  - Assert tri-state rendering:
    - loading state when `gitLoading=true` and no summary
    - unavailable state when `gitError=true` and no summary
    - normal state when summary present
  - Assert detached fallback label when `branch` is null.
- Integration (SessionChat -> SessionHeader):
  - Assert last successful git summary remains visible during subsequent loading/error.
  - Assertion point: no text switch to `session.git.unavailable` if cached summary exists.

### 7. Wrong vs Correct

#### Wrong

```typescript
// recompute ad-hoc summary and drop existing typed contract
const gitSummary = gitStatus
  ? {
      branch: gitStatus.branch,
      staged: gitStatus.totalStaged,
      unstaged: gitStatus.totalUnstaged,
    }
  : null

// on any query error, always show unavailable
<SessionHeader gitError={Boolean(gitError)} gitSummary={gitSummary} />
```

#### Correct

```typescript
// reuse GitStatusFiles shape directly, avoid duplicate mapping
const lastGitStatusRef = useRef<GitStatusFiles | null>(null)
if (gitStatus) lastGitStatusRef.current = gitStatus
const gitStatusForHeader = gitStatus ?? lastGitStatusRef.current

<SessionHeader
  gitSummary={gitStatusForHeader}
  gitLoading={gitLoading && !gitStatusForHeader}
  gitError={Boolean(gitError) && !gitStatusForHeader}
/>
```

---

## Common Mistakes

- ❌ Forgetting `use` prefix on hook names
- ❌ Putting business logic directly in components instead of hooks
- ❌ Not using `useCallback` for returned functions
- ❌ Stale closures (reading old state/props in callbacks) - use refs
- ❌ Not cleaning up side effects (event listeners, timers, async operations)
- ❌ Hardcoding query keys instead of using centralized `queryKeys`
- ❌ Not handling `api: null` case in query/mutation hooks
- ❌ Using `any` type in hook return values
- ❌ Returning arrays instead of objects for complex return values
- ❌ Not providing default values for optional data (e.g., `?? []`)
- ❌ Forgetting `enabled` option when query depends on other state
