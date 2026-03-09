# Directory Structure

> How frontend code is organized in this project.

---

## Overview

HAPI Web follows a feature-based organization with clear separation between UI components, business logic (hooks), and utilities. The structure emphasizes:

- **Component isolation**: UI components are separated by feature/domain
- **Hook-based logic**: Business logic lives in custom hooks, not components
- **Type safety**: Shared types in dedicated directory
- **Path aliases**: `@/*` maps to `src/*` for clean imports

---

## Directory Layout

```
web/src/
├── api/                    # API client and HTTP utilities
├── chat/                   # Chat-specific logic (message normalization, etc.)
├── components/             # React components
│   ├── assistant-ui/       # Assistant UI integration components
│   ├── AssistantChat/      # Main chat interface components
│   ├── ChatInput/          # Chat input with autocomplete
│   ├── NewSession/         # Session creation flow
│   ├── SessionFiles/       # File management UI
│   ├── Terminal/           # Terminal emulator components
│   ├── ToolCard/           # Tool call display components
│   └── ui/                 # Reusable UI primitives (Button, Dialog, etc.)
├── hooks/                  # Custom React hooks
│   ├── mutations/          # React Query mutation hooks
│   └── queries/            # React Query query hooks
├── lib/                    # Shared utilities and helpers
│   └── locales/            # i18n translation files
├── realtime/               # Real-time connection logic (Socket.IO, SSE)
│   └── hooks/              # Real-time specific hooks
├── routes/                 # Route components (TanStack Router)
│   ├── sessions/           # Session-related routes
│   └── settings/           # Settings routes
├── types/                  # TypeScript type definitions
├── utils/                  # General utility functions
├── App.tsx                 # Root app component
├── main.tsx                # App entry point
└── router.tsx              # Route configuration
```

---

## Module Organization

### Components

**Feature-based grouping**: Components are grouped by feature/domain, not by type.

- `components/AssistantChat/` - All chat-related components
- `components/Terminal/` - Terminal emulator components
- `components/ui/` - Generic, reusable UI primitives

**Component file structure**:
```
components/AssistantChat/
├── HappyThread.tsx         # Main thread component
├── HappyComposer.tsx       # Message composer
├── context.tsx             # Shared context
├── messages/               # Message type components
│   ├── AssistantMessage.tsx
│   ├── UserMessage.tsx
│   └── SystemMessage.tsx
└── StatusBar.tsx
```

### Hooks

**Separation by purpose**:
- `hooks/` - General custom hooks (auth, clipboard, platform detection)
- `hooks/queries/` - React Query data fetching hooks
- `hooks/mutations/` - React Query mutation hooks
- `realtime/hooks/` - Real-time connection hooks

**Hook naming**: Always prefix with `use` (e.g., `useAuth`, `useCopyToClipboard`)

### Routes

**File-based routing** with TanStack Router:
- Route components live in `routes/`
- Nested routes use subdirectories (e.g., `routes/sessions/`)
- Route configuration in `router.tsx`

---

## Naming Conventions

### Files

- **Components**: PascalCase (e.g., `HappyThread.tsx`, `Button.tsx`)
- **Hooks**: camelCase with `use` prefix (e.g., `useAuth.ts`, `useCopyToClipboard.ts`)
- **Utilities**: camelCase (e.g., `utils.ts`, `clipboard.ts`)
- **Types**: camelCase (e.g., `api.ts`, `session.ts`)

### Directories

- **Feature directories**: PascalCase (e.g., `AssistantChat/`, `Terminal/`)
- **Utility directories**: lowercase (e.g., `hooks/`, `lib/`, `utils/`)

### Imports

Always use path aliases for cleaner imports:

```typescript
// Good
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import type { Session } from '@/types/api'

// Bad
import { Button } from '../../../components/ui/button'
```

---

## Examples

### Well-organized modules

- **`components/AssistantChat/`** - Feature-complete chat interface with clear component hierarchy
- **`hooks/useAuth.ts`** - Complex authentication logic encapsulated in a hook
- **`components/ui/`** - Reusable UI primitives following consistent patterns

### Adding a new feature

When adding a new feature (e.g., "CodeReview"):

1. Create feature directory: `components/CodeReview/`
2. Add main component: `components/CodeReview/CodeReviewPanel.tsx`
3. Add feature-specific hooks: `hooks/useCodeReview.ts`
4. Add types: `types/codeReview.ts`
5. Add route (if needed): `routes/code-review.tsx`

---

## Anti-patterns

### Don't

- ❌ Mix feature components with UI primitives in `components/ui/`
- ❌ Put business logic directly in components (use hooks instead)
- ❌ Use relative imports when path aliases are available
- ❌ Create deeply nested directory structures (max 3 levels)
- ❌ Mix different concerns in one directory (e.g., components + hooks in same folder)

### Do

- ✅ Group related components by feature
- ✅ Extract business logic into custom hooks
- ✅ Use path aliases (`@/*`) for all imports
- ✅ Keep directory structure flat and discoverable
- ✅ Separate concerns (components, hooks, types, utils)
