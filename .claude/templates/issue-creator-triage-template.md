# Issue Creation Triage Template - HAPImatic

## Purpose
Determine whether to use SIMPLE or FULL workflow for issue creation.

## Triage Assessment

### Simplicity Criteria Checklist

For SIMPLE workflow, ALL criteria must be TRUE:

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Single file affected | [ ] |
| 2 | Change is isolated (no ripple effects) | [ ] |
| 3 | Only UI changes OR only backend changes (not both) | [ ] |
| 4 | Clear, unambiguous requirement | [ ] |
| 5 | No external system interaction | [ ] |
| 6 | Estimated effort < 30 minutes | [ ] |

### Complexity Indicators

If ANY of these are true, use FULL workflow:

- [ ] Multiple files or workspaces affected (cli, web, server, shared)
- [ ] Both UI and backend changes required
- [ ] Architecture or design decisions needed
- [ ] External systems involved (systemd, Tailscale)
- [ ] PWA manifest, service worker, or icon changes
- [ ] Ambiguous requirements needing clarification
- [ ] Risk of breaking existing functionality
- [ ] Build process or tooling changes

### Triage Decision

```
Simplicity Score: [X/6 criteria met]
Complexity Indicators: [X found]

WORKFLOW DECISION: [SIMPLE / FULL]
CONFIDENCE: [HIGH / MEDIUM / LOW]
```

**Rule**: When in doubt, choose FULL. The cost of over-analysis is low.

## Next Steps

- **If SIMPLE**: Use abbreviated issue format, quick duplicate check
- **If FULL**: Use comprehensive issue format, invoke Explore agent for context
