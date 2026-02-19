# TDD Workflow

Follow RED → GREEN → REFACTOR for feature work.

## RED (prove tests fail first)

Run target tests before implementation:
```bash
bun run test:hub    # hub tests
bun run test:web    # web tests
bun run test:cli    # cli tests
```

Record which tests fail and why the failure is expected.

## GREEN (make tests pass)

Implement minimum code required. Re-run target tests after each meaningful change. Keep scope aligned to acceptance criteria.

## REFACTOR (clean and stabilize)

Improve structure and naming while keeping tests green. Remove dead code and unused imports in touched files.

## Quality Gates

Run before marking complete:
```bash
bun run typecheck    # tsc --noEmit across all packages
bun run test         # full test suite
```

## Completion Report

```text
Tests before: <count> failing (expected)
Tests after: All passing
Typecheck: PASS/FAIL
```

## Red Flags (require rework)

- Implementation started before RED evidence
- "Tests pass" claim without command output
- Typecheck skipped
- Tests changed to hide defects instead of fixing implementation
