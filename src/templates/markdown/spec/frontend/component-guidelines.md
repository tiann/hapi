# Component Guidelines

> How components are built in this project.

---

## Overview

HAPI Web uses React 19 with TypeScript. Components follow functional patterns with clear prop typing, Tailwind CSS for styling, and accessibility built-in. Components are small, focused, and composable.

**Key libraries**:
- React 19 with hooks
- TanStack Router for routing
- @assistant-ui/react for AI chat primitives
- Tailwind CSS v4 for styling
- class-variance-authority (CVA) for variant-based styling
- clsx + tailwind-merge via `cn()` utility

---

## Component Structure

### Standard Component Pattern

```typescript
// components/Spinner.tsx
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

type SpinnerProps = {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string | null
}

export function Spinner({
    size = 'md',
    className,
    label
}: SpinnerProps) {
    const { t } = useTranslation()
    // ...
    return <svg ...>...</svg>
}
```

Key aspects:
1. Named function export (not default)
2. Props type defined locally with `type` keyword
3. Destructured props with defaults in function signature
4. `cn()` utility for conditional className merging
5. `useTranslation()` for any user-visible text

### Context Provider Pattern

Feature-scoped contexts use a Provider component + typed hook:

```typescript
// components/AssistantChat/context.tsx
export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    disabled: boolean
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return <HappyChatContext.Provider value={props.value}>{props.children}</HappyChatContext.Provider>
}

// Always throw when context is missing - never return undefined
export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useContext(HappyChatContext)
    if (!ctx) throw new Error('HappyChatContext is missing')
    return ctx
}
```

### UI Primitives with Variants (CVA pattern)

For reusable UI primitives, use class-variance-authority:

```typescript
// components/ui/button.tsx
import { cva, type VariantProps } from 'class-variance-authority'

const buttonVariants = cva(
    'inline-flex items-center justify-center ...', // base classes
    {
        variants: {
            variant: {
                default: 'bg-[var(--app-button)] text-[var(--app-button-text)]',
                secondary: '...',
            },
            size: { default: 'h-9 px-4 py-2', sm: 'h-8 ...' }
        },
        defaultVariants: { variant: 'default', size: 'default' }
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : 'button'
        return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    }
)
Button.displayName = 'Button'
```

---

## Props Conventions

### Type Definition

- Use `type` (not `interface`) for component props
- Name props types as `<ComponentName>Props`
- Define props types in the same file as the component

```typescript
// Good
type SpinnerProps = {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string | null
}

// Bad - Don't use interface for simple props
interface SpinnerProps {
    size?: string
}
```

### Optional vs Required

- Make props optional with `?` when they have sensible defaults
- Always provide default values in destructuring, not as separate variables
- Use `null` explicitly for "intentionally empty" (e.g., `label?: string | null`)

```typescript
// Good - defaults in destructuring
function Spinner({ size = 'md', className, label }: SpinnerProps) {}

// Bad - defaults elsewhere
function Spinner(props: SpinnerProps) {
    const size = props.size ?? 'md'  // Don't do this
}
```

### Children

- Use `ReactNode` type for children prop
- Always name it `children`

```typescript
type MyComponentProps = {
    children: ReactNode
    className?: string
}
```

### Event Handlers

- Name event handler props with `on` prefix (e.g., `onRetry`, `onLoadMore`)
- Type them precisely, not with generic `() => void`

```typescript
type ThreadProps = {
    onLoadMore: () => Promise<unknown>  // Good - precise return type
    onRetryMessage?: (localId: string) => void  // Good - parameter typed
}
```

---

## Styling Patterns

### CSS Variables for Theme Colors

Always use CSS custom properties for theme-aware colors, never hardcoded values:

```typescript
// Good - uses CSS variables
'bg-[var(--app-button)] text-[var(--app-button-text)]'
'bg-[var(--app-secondary-bg)]'
'text-[var(--app-fg)]'
'border-[var(--app-border)]'

// Bad - hardcoded colors that don't respond to theme
'bg-blue-500 text-white'
```

Available CSS variables:
- `--app-bg` - Main background
- `--app-fg` - Main foreground/text
- `--app-secondary-bg` - Secondary background
- `--app-subtle-bg` - Subtle background (for hover states)
- `--app-button` - Button background
- `--app-button-text` - Button text
- `--app-border` - Border color
- `--app-link` - Link/accent color
- `--app-hint` - Hint/muted text

### The `cn()` Utility

Always use `cn()` for combining class names:

```typescript
import { cn } from '@/lib/utils'

// Good
<div className={cn('base-classes', condition && 'conditional-class', className)} />

// Bad - direct string concatenation
<div className={`base-classes ${condition ? 'conditional-class' : ''} ${className}`} />
```

### Responsive and Conditional Classes

```typescript
// Conditional classes
<div className={cn(
    'base px-3 py-2',
    isActive && 'bg-[var(--app-subtle-bg)]',
    isDisabled && 'opacity-50 pointer-events-none'
)} />
```

---

## Accessibility

### Required Patterns

1. **Loading states**: Use `role="status"` and `aria-label` for spinners
2. **Hidden decorative content**: Use `aria-hidden="true"`
3. **Screen reader only text**: Use `sr-only` Tailwind class
4. **Interactive elements**: Ensure all clickable elements are keyboard accessible

```typescript
// Spinner accessibility (from Spinner.tsx)
const accessibilityProps = effectiveLabel === null
    ? { 'aria-hidden': true }
    : { role: 'status', 'aria-label': effectiveLabel }
```

```typescript
// Screen reader only text for skeleton loading
<span className="sr-only">{t('misc.loadingMessages')}</span>
```

```typescript
// Loading button state
<Button aria-busy={isLoadingMoreMessages}>...</Button>
```

### Translation

All user-visible text must use `useTranslation()`:

```typescript
// Good
const { t } = useTranslation()
return <span>{t('misc.loading')}</span>

// Bad - hardcoded strings
return <span>Loading...</span>
```

---

## Scenario: Long Content Auto-Collapse (UI-only contract)

### 1. Scope / Trigger
- Trigger: Message/tool/CLI content can exceed readable size and degrade chat usability.
- Scope: Frontend rendering layer only (`web/src/components/*`), no reducer/protocol/API changes.

### 2. Signatures

```typescript
// web/src/lib/contentLimits.ts
export const LONG_CONTENT_COLLAPSE_THRESHOLD = 1000

export function shouldAutoCollapseContent(
  text: string,
  threshold: number = LONG_CONTENT_COLLAPSE_THRESHOLD
): boolean
```

```typescript
// web/src/components/LongContentCollapse.tsx
export function LongContentCollapse(props: {
  text: string
  children: ReactNode
  className?: string
  threshold?: number
}): JSX.Element
```

### 3. Contracts
- Collapse rule: `text.length > threshold` => collapsed by default.
- Boundary rule: `text.length === threshold` => do not collapse.
- Interaction contract:
  - collapsed state: `aria-expanded="false"`
  - expanded state: `aria-expanded="true"`
- i18n contract (must not hardcode user-visible labels):
  - `content.collapse.openWithHidden`
  - `content.collapse.close`

### 4. Validation & Error Matrix
- Missing i18n key -> fallback to English key resolution path in `I18nProvider`.
- `threshold` not provided -> use `LONG_CONTENT_COLLAPSE_THRESHOLD` default.
- Empty text (`""`) -> never collapsed.

### 5. Good / Base / Bad Cases
- Good: long text in `CodeBlock`, `MarkdownRenderer`, `CliOutputBlock` collapses consistently with same toggle behavior.
- Base: text exactly 1000 chars renders without collapse toggle.
- Bad: hardcoded labels in component or per-view custom threshold causing inconsistent UX.

### 6. Tests Required
- Component tests must cover:
  1. boundary case (`=== threshold`) no toggle button,
  2. over-threshold case (`> threshold`) default collapsed,
  3. click toggle changes `aria-expanded` false -> true.
- For i18n-sensitive assertions, read label from locale keys instead of duplicating hardcoded literals.

### 7. Wrong vs Correct

```tsx
// Wrong: hardcoded label (breaks i18n consistency)
<span>展开长消息（已隐藏部分）</span>
```

```tsx
// Correct: translated label
const { t } = useTranslation()
<span>{t('content.collapse.openWithHidden')}</span>
```

---

## Local Sub-Components

For sub-components only used within one file, define them in the same file above the main export:

```typescript
// Good - local helper component in same file
function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) return null
    return <button onClick={props.onClick}>...</button>
}

function MessageSkeleton() {
    return <div className="space-y-3 animate-pulse">...</div>
}

// Main exported component
export function HappyThread(props: HappyThreadProps) {
    return (
        // Uses local sub-components
        <NewMessagesIndicator ... />
    )
}
```

---

## Common Mistakes

- ❌ Using `interface` instead of `type` for props
- ❌ Hardcoding colors instead of CSS variables
- ❌ Leaving untranslated user-visible strings
- ❌ Missing `aria-*` attributes on loading/interactive elements
- ❌ Using `default export` (use named exports)
- ❌ Putting business logic directly in component body (use hooks)
- ❌ Using relative imports instead of `@/` aliases
- ❌ Mutating props directly
- ❌ Using `any` type in props definitions
