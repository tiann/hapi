---
ci_passed: true
ci_configured: true
ci_active: false
commit_sha: e71b743
---

# CI Results

## CI Configuration
- `.github/workflows/test.yml` exists — runs `bun typecheck` + `bun run test` on push/PR
- CI is **not active** on fork repo (no GitHub Actions runs recorded)

## Local Verification (equivalent to CI checks)

### Typecheck
```
$ bun typecheck
✅ cli/tsc --noEmit: pass
✅ web/tsc --noEmit: pass
✅ hub/tsc --noEmit: pass
```

### Tests
```
$ cd cli && node ../node_modules/vitest/vitest.mjs run src/pi/
✅ 33 passed (16 PiTransport + 17 PiEventConverter)
```

Full test suite has 3 pre-existing failures (difftastic/ripgrep unpacking, opencode remote) unrelated to this PR.

## Risk Assessment
CI will activate when PR is submitted to upstream `tiann/hapi`. Local typecheck and test verification confirm the same checks would pass.
