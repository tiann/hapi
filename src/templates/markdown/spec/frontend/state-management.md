# State Management

> How state is managed in this project.

---

## Overview

HAPI Web uses a **hybrid state management approach**:

1. **Local component state** (`useState`, `useReducer`) for UI-only state
2. **TanStack Query** for server state (API data, caching, synchronization)
3. **Module-level stores** for cross-component state that doesn't fit React Query
4. **URL state** (TanStack Router) for navigation and shareable state
5. **Context** for dependency injection (API client, session context)

**No global state library** (Redux, Zustand, etc.) - state is kept as local as possible.

---

## State Categories

### 1. Local Component State

Use `useState` or `useReducer` for state that only affects one component:

```typescript
// UI-only state
const [isOpen, setIsOpen] = useState(false)
const [copied, setCopied] = useState(false)
const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
```

**When to use**:
- UI toggles (modals, dropdowns, expanded/collapsed)
- Form input values (before submission)
- Temporary UI state (loading spinners, animations)

### 2. Server State (TanStack Query)

Use TanStack Query for all server data:

```typescript
// Query for read operations
const { sessions, isLoading, error, refetch } = useSessions(api)

// Mutation for write operations
const { sendMessage, isSending } = useSendMessage(api, sessionId)
```

**When to use**:
- Any data from API endpoints
- Data that needs caching
- Data that needs background refetching
- Optimistic updates

**Configuration** (`lib/query-client.ts`):
```typescript
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5_000,           // Cache for 5 seconds
            refetchOnWindowFocus: false, // Don't refetch on tab focus
            retry: 1,                    // Retry failed queries once
        },
        mutations: {
            retry: 0,                    // Don't retry mutations
        },
    },
})
```

### 3. Module-Level Stores

For cross-component state that doesn't fit React Query, use module-level stores with subscription pattern:

```typescript
// lib/message-window-store.ts
const states = new Map<string, MessageWindowState>()
const listeners = new Map<string, Set<() => void>>()

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return states.get(sessionId) ?? createInitialState(sessionId)
}

export function subscribeToMessageWindow(sessionId: string, listener: () => void): () => void {
    const sessionListeners = listeners.get(sessionId) ?? new Set()
    sessionListeners.add(listener)
    listeners.set(sessionId, sessionListeners)
    return () => sessionListeners.delete(listener)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    const state = getMessageWindowState(sessionId)
    // ... update state
    notifyListeners(sessionId)
}
```

**When to use**:
- Real-time message windows (optimistic updates, pending messages)
- State that needs to persist across component unmounts
- State shared by multiple unrelated components
- Performance-critical state (avoid React re-renders)

**Pattern**: Expose getters, setters, and subscription functions. Components subscribe in `useEffect`.

### 4. URL State (TanStack Router)

Use URL parameters for shareable/bookmarkable state:

```typescript
// Route definition
export const Route = createFileRoute('/sessions/$sessionId')({
    component: SessionPage,
})

// Access in component
const { sessionId } = Route.useParams()
```

**When to use**:
- Current page/view (session ID, settings tab)
- Filters and search queries
- Any state that should be shareable via URL

### 5. Context (Dependency Injection)

Use Context for passing dependencies down the tree, not for state:

```typescript
// components/AssistantChat/context.tsx
export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
}

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return <HappyChatContext.Provider value={props.value}>{props.children}</HappyChatContext.Provider>
}
```

**When to use**:
- Passing API client to deeply nested components
- Feature-scoped configuration (session context, theme)
- Callbacks that need to be accessible deep in the tree

**Don't use for**:
- Frequently changing state (causes re-renders of entire subtree)
- State that could be local or in React Query

---

## When to Use Global State

**Prefer local state by default.** Only promote to global when:

1. **Multiple unrelated components** need the same state
2. **State must persist** across component unmounts
3. **Performance critical** (avoiding prop drilling causes re-renders)
4. **Real-time updates** that don't fit React Query model

**Example**: Message window state is global because:
- Multiple components need it (thread, composer, status bar)
- Must persist when scrolling (component unmounts)
- Optimistic updates need immediate UI feedback
- Real-time messages arrive via WebSocket

---

## Server State Best Practices

### Query Keys

Centralize in `lib/query-keys.ts`:

```typescript
export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (id: string) => ['session', id] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
    machines: ['machines'] as const,
}
```

### Optimistic Updates

For mutations that need instant feedback:

```typescript
const mutation = useMutation({
    mutationFn: async (input) => {
        await api.sendMessage(input.sessionId, input.text, input.localId)
    },
    onMutate: async (input) => {
        // Add message to UI immediately
        appendOptimisticMessage(input.sessionId, {
            id: input.localId,
            content: { role: 'user', content: { type: 'text', text: input.text } },
            status: 'sending',
        })
    },
    onSuccess: (_, input) => {
        // Update status to 'sent'
        updateMessageStatus(input.sessionId, input.localId, 'sent')
    },
    onError: (_, input) => {
        // Update status to 'failed'
        updateMessageStatus(input.sessionId, input.localId, 'failed')
    },
})
```

### Cache Invalidation

Invalidate queries after mutations:

```typescript
const mutation = useMutation({
    mutationFn: async (sessionId) => {
        await api.deleteSession(sessionId)
    },
    onSuccess: () => {
        // Refetch sessions list
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    },
})
```

---

## Derived State

### Compute in Render

For simple derived state, compute directly in render:

```typescript
function SessionList({ sessions }: { sessions: Session[] }) {
    const activeSessions = sessions.filter(s => s.active)
    const inactiveSessions = sessions.filter(s => !s.active)
    // ...
}
```

### useMemo for Expensive Computations

Only use `useMemo` when computation is expensive:

```typescript
const sortedSessions = useMemo(() => {
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}, [sessions])
```

**Don't** use `useMemo` for cheap operations - it adds overhead.

---

## Common Mistakes

- ❌ Using Context for frequently changing state (causes re-renders)
- ❌ Lifting state too early (keep it local until you need to share)
- ❌ Not using TanStack Query for server data (reinventing caching/refetching)
- ❌ Storing derived state instead of computing it
- ❌ Using `useMemo` for cheap computations (premature optimization)
- ❌ Not invalidating queries after mutations
- ❌ Forgetting to clean up subscriptions in module-level stores
- ❌ Putting UI state in URL (only shareable state belongs there)
- ❌ Using global state when local state would work
- ❌ Not providing default values for optional query data (`?? []`)

---

## State Flow Example

**Sending a message**:

1. User types in composer (local state: `useState`)
2. User clicks send → `useSendMessage` mutation
3. Mutation's `onMutate` adds optimistic message to module store
4. Module store notifies subscribers → UI updates immediately
5. API call completes → `onSuccess` updates message status
6. Real-time WebSocket receives confirmation → updates module store again

**Why this works**:
- Local state for input (no need to share)
- TanStack Query for API call (caching, retry, error handling)
- Module store for message window (cross-component, real-time, optimistic)
- No prop drilling, no unnecessary re-renders
