# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

HAPI Web maintains high code quality through:

- **TypeScript strict mode** - No implicit any, strict null checks
- **Vitest** for unit testing with jsdom environment
- **Testing Library** for component testing
- **Manual testing** for UI/UX validation
- **Code review** before merging

**Philosophy**: Pragmatic quality - test critical paths, not everything. Focus on user-facing functionality and business logic.

---

## Forbidden Patterns

### ❌ Never Use

1. **`any` type** - Use `unknown` instead
   ```typescript
   // Bad
   function handle(data: any) { }

   // Good
   function handle(data: unknown) { }
   ```

2. **Ignoring TypeScript errors** - Fix the root cause
   ```typescript
   // Bad
   // @ts-ignore
   const value = data.prop

   // Good - proper type guard
   const value = typeof data === 'object' && data && 'prop' in data ? data.prop : undefined
   ```

3. **Hardcoded colors** - Use CSS variables
   ```typescript
   // Bad
   'bg-blue-500 text-white'

   // Good
   'bg-[var(--app-button)] text-[var(--app-button-text)]'
   ```

4. **Untranslated user-visible text** - Use `useTranslation()`
   ```typescript
   // Bad
   <span>Loading...</span>

   // Good
   const { t } = useTranslation()
   <span>{t('loading')}</span>
   ```

5. **Default exports** - Use named exports
   ```typescript
   // Bad
   export default function Button() { }

   // Good
   export function Button() { }
   ```

6. **Business logic in components** - Extract to hooks
   ```typescript
   // Bad - logic in component
   function MyComponent() {
       const [data, setData] = useState(null)
       useEffect(() => {
           fetch('/api/data').then(r => r.json()).then(setData)
       }, [])
   }

   // Good - logic in hook
   function MyComponent() {
       const { data } = useData()
   }
   ```

7. **Relative imports** - Use path aliases
   ```typescript
   // Bad
   import { Button } from '../../../components/ui/button'

   // Good
   import { Button } from '@/components/ui/button'
   ```

8. **Missing accessibility attributes**
   ```typescript
   // Bad - no aria attributes
   <div onClick={handleClick}>Click me</div>

   // Good - proper button with accessibility
   <button onClick={handleClick} aria-label="Submit form">Click me</button>
   ```

---

## Required Patterns

### ✅ Always Use

1. **Named exports** for all components and hooks
   ```typescript
   export function MyComponent() { }
   export function useMyHook() { }
   ```

2. **Type-only imports** for types
   ```typescript
   import type { Session } from '@/types/api'
   ```

3. **`cn()` utility** for className merging
   ```typescript
   import { cn } from '@/lib/utils'
   <div className={cn('base-class', condition && 'conditional', className)} />
   ```

4. **CSS variables** for theme colors
   ```typescript
   'bg-[var(--app-bg)] text-[var(--app-fg)]'
   ```

5. **`useTranslation()`** for all user-visible text
   ```typescript
   const { t } = useTranslation()
   return <span>{t('misc.loading')}</span>
   ```

6. **Path aliases** (`@/*`) for imports
   ```typescript
   import { useAuth } from '@/hooks/useAuth'
   ```

7. **Cleanup in useEffect** for side effects
   ```typescript
   useEffect(() => {
       const listener = () => { }
       element.addEventListener('event', listener)
       return () => element.removeEventListener('event', listener)
   }, [])
   ```

8. **Error boundaries** for component error handling
   - Wrap route components in error boundaries
   - Provide fallback UI for errors

9. **Loading states** for async operations
   ```typescript
   if (isLoading) return <Spinner />
   if (error) return <ErrorMessage error={error} />
   return <Content data={data} />
   ```

---

## Testing Requirements

### Test Setup

- **Framework**: Vitest with jsdom environment
- **Component testing**: @testing-library/react
- **Location**: Tests live next to source files (`*.test.ts`, `*.test.tsx`)
- **Run**: `bun run test` (from web directory)

### What to Test

**Priority 1 - Critical paths**:
- Authentication flows
- Message sending/receiving
- Session management
- File operations

**Priority 2 - Business logic**:
- Custom hooks with complex logic
- Utility functions
- Data transformations
- State management logic

**Priority 3 - Components** (selective):
- Complex interactive components
- Components with conditional rendering logic
- Form validation logic

**Don't test**:
- Simple presentational components
- Third-party library wrappers
- Trivial utility functions
- Type definitions

### Test Structure

```typescript
// lib/clipboard.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('clipboard utilities', () => {
    beforeEach(() => {
        // Setup
    })

    afterEach(() => {
        // Cleanup
    })

    it('copies text to clipboard', async () => {
        // Arrange
        const text = 'test'

        // Act
        const result = await copyToClipboard(text)

        // Assert
        expect(result).toBe(true)
    })
})
```

### Component Testing

```typescript
// components/LoginPrompt.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { LoginPrompt } from './LoginPrompt'

describe('LoginPrompt', () => {
    it('renders login button', () => {
        render(<LoginPrompt />)
        expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument()
    })
})
```

---

## Accessibility Requirements

### Minimum Standards

1. **Semantic HTML** - Use proper elements
   - `<button>` for buttons, not `<div onClick>`
   - `<nav>` for navigation
   - `<main>` for main content

2. **ARIA attributes** where needed
   - `aria-label` for icon-only buttons
   - `aria-busy` for loading states
   - `role="status"` for status messages
   - `aria-hidden="true"` for decorative elements

3. **Keyboard navigation**
   - All interactive elements must be keyboard accessible
   - Proper focus management
   - No keyboard traps

4. **Screen reader support**
   - Use `sr-only` class for screen-reader-only text
   - Provide text alternatives for visual content
   - Announce dynamic content changes

5. **Color contrast**
   - Use CSS variables that meet WCAG AA standards
   - Don't rely on color alone to convey information

### Example

```typescript
// Good accessibility
<button
    onClick={handleSubmit}
    aria-busy={isLoading}
    aria-label="Submit form"
    disabled={isDisabled}
>
    {isLoading ? (
        <>
            <Spinner size="sm" label={null} />
            <span className="sr-only">{t('loading')}</span>
        </>
    ) : (
        t('submit')
    )}
</button>
```

---

## Code Review Checklist

### Before Submitting

- [ ] TypeScript compiles without errors (`bun run typecheck`)
- [ ] Tests pass (`bun run test`)
- [ ] No console errors in browser
- [ ] Manual testing completed for changed functionality
- [ ] Accessibility tested (keyboard navigation, screen reader)
- [ ] All user-visible text is translated
- [ ] No hardcoded colors (CSS variables used)
- [ ] Path aliases used for imports
- [ ] No `any` types
- [ ] Proper error handling for async operations

### Reviewer Checklist

**Code Quality**:
- [ ] Follows component/hook guidelines
- [ ] No forbidden patterns used
- [ ] Proper TypeScript types (no `any`)
- [ ] Business logic extracted to hooks
- [ ] Proper error handling

**Functionality**:
- [ ] Feature works as expected
- [ ] Edge cases handled
- [ ] Loading states present
- [ ] Error states handled gracefully

**Accessibility**:
- [ ] Semantic HTML used
- [ ] ARIA attributes where needed
- [ ] Keyboard accessible
- [ ] Screen reader friendly

**Performance**:
- [ ] No unnecessary re-renders
- [ ] Proper memoization (if needed)
- [ ] Cleanup in useEffect
- [ ] No memory leaks

**Maintainability**:
- [ ] Code is readable and well-organized
- [ ] Complex logic has comments
- [ ] Consistent with existing patterns
- [ ] No duplication

---

## Build and Type Checking

### Commands

```bash
# Type checking
bun run typecheck

# Run tests
bun run test

# Build for production
bun run build

# Development server
bun run dev
```

### Pre-commit Requirements

Before committing:
1. Run `bun run typecheck` - must pass
2. Run `bun run test` - must pass
3. Manual testing of changed functionality
4. No console errors in browser

---

## Common Mistakes

- ❌ Using `any` type
- ❌ Ignoring TypeScript errors
- ❌ Hardcoding colors instead of CSS variables
- ❌ Forgetting to translate user-visible text
- ❌ Using default exports
- ❌ Putting business logic in components
- ❌ Using relative imports
- ❌ Missing accessibility attributes
- ❌ Not cleaning up side effects in useEffect
- ❌ Not handling loading/error states
- ❌ Using `interface` instead of `type` for props
- ❌ Not testing critical paths

---

## Performance Considerations

### Optimization Guidelines

1. **Lazy load routes** - Use code splitting for routes
2. **Memoize expensive computations** - Use `useMemo` sparingly
3. **Avoid unnecessary re-renders** - Use `useCallback` for callbacks passed to children
4. **Optimize images** - Use appropriate formats and sizes
5. **Bundle size** - Monitor and keep dependencies minimal

### When NOT to Optimize

- Don't use `useMemo` for cheap computations
- Don't use `useCallback` everywhere (adds overhead)
- Don't optimize before measuring (premature optimization)

---

## Summary

**Core principles**:
1. Type safety first (strict TypeScript)
2. Accessibility built-in (not an afterthought)
3. Test critical paths (pragmatic testing)
4. Keep it simple (KISS, YAGNI, DRY)
5. Follow existing patterns (consistency)
