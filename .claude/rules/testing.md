---
description: Testing conventions and patterns
globs: "**/*.test.*, **/*.spec.*"
---

# Testing Conventions

## Test Commands

```bash
bun run test         # all packages
bun run test:hub     # hub only
bun run test:web     # web only
bun run test:cli     # cli only
bun run typecheck    # tsc --noEmit across all packages
```

## Conventions

- Test files live alongside source files (e.g., `store.test.ts` next to `store/index.ts`)
- Name test files `*.test.ts` or `*.test.tsx`
- Use descriptive test names that explain the expected behavior
- Run the package-specific test command when working in one package, full suite before completing work
