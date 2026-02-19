---
description: Patterns for the web SPA package
globs: web/**
---

# Web Package Patterns

## Stack: React 19 + TypeScript + Tailwind CSS

- Functional components with explicit TypeScript prop types
- Tailwind CSS for all styling
- CSS variables for theming (`--app-bg`, `--app-fg`, `--app-hint`) with `data-theme="dark"` support
- Use `cn()` utility (from `@/lib/utils`) for class composition

## State Management

- **Server state**: TanStack React Query. Custom hooks in `hooks/queries/` and `hooks/mutations/`. Query keys centralized in `lib/query-keys.ts`.
- **App state**: React Context (`AppContextProvider`, `ToastProvider`, `VoiceProvider`, `I18nProvider`)

## Routing: TanStack React Router

File-based routes under `src/routes/`. Programmatic route creation in `router.tsx` using `createRootRoute()` and `createRoute()`.

## API Communication

- REST: Custom `ApiClient` class in `api/client.ts` (fetch-based)
- Realtime: Socket.io client (`socket.io-client`)
- SSE: Custom `useSSE()` hook for pub/sub events

## File Organization

```
src/
├── components/    # React components
├── hooks/         # Custom hooks (queries/, mutations/, UI patterns)
├── lib/           # Utilities, contexts, config
├── api/           # API client
├── routes/        # File-based routes
├── types/         # TypeScript type definitions
├── chat/          # Chat-specific logic
└── realtime/      # Socket.io logic
```
