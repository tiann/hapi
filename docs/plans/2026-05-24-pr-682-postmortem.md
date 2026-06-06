# Post-mortem: missed regressions in upstream PR #682

Captured 2026-05-24. Not upstream canon — fork process notes only.

## What happened

PR #682 (`fix/voice-readback`) shipped to upstream with two regressions that a bot caught and we didn't. Both were in `contextFormatters.ts`.

### Regression 1 — tool-call context dropped for mixed Claude content arrays

`extractSpeakableFromContent` was inserted unconditionally before the existing content-array loop in `formatMessage`. Because the helper also handles arrays (lines 159–172: it collects text items and joins them), a mixed `[text, tool_use]` Claude assistant payload hit the early return path and the `tool_use` voice context line was silently dropped.

Fixed in `818bf7c`: guard with `!isContentArray(content)` so arrays fall through to the existing loop.

### Regression 2 — session status events could become ready readback text

`extractSpeakableFromContent` matched any object with `typeof content.type === 'string'` and a `data` property. `sendSessionEvent({ type: 'message', message })` emits `{ type: 'event', data: { type: 'message', message } }` — which satisfied the check. A status string like "Aborting task" could be formatted as `Claude Code:` text and selected as the last assistant speakable for the ready readback instead of the actual agent answer.

Fixed in `09e9b55`: narrow to `content.type === 'codex'`, matching the comment that was already there.

## Why we missed both

**Didn't read the helper completely before reusing it.**
`extractSpeakableFromContent` was written to serve `extractLastAssistantSpeakable`. When it was dropped into `formatMessage` the full branch tree wasn't re-read. The array branch (regression 1) and the overly broad type guard (regression 2) were both visible in the function body.

**Passing tests in the wrong place gave false confidence.**
`extractLastAssistantSpeakable` had a content-array test that passed. That's a different call site where array handling is correct. Seeing green on "content array" was enough to stop looking.

**The new test file only covered new paths.**
Every test in `contextFormatters.test.ts` exercises the Codex stream-json path. Nothing tested the pre-existing Claude session path in `formatMessage` — specifically a mixed `text`+`tool_use` payload, and nothing tested that status events stay silent.

**Submitted with an unchecked box.**
The PR test plan had `[ ] Regression: Claude session voice still works` left unchecked. That was the gap flagging itself. Filed anyway.

## What to do differently next time

1. Before inserting a helper into a second call site, trace every branch it contains and ask: "does this helper also handle the thing the surrounding code handles?" If yes, the interaction needs a test.
2. When `grep` shows a passing test for "the same concept", check which function it tests. Passing in function A does not mean covered in function B.
3. New test files should include at least one test for each pre-existing code path in every function they touch, not only for the new feature paths.
4. An unchecked test plan item is a submit blocker. Convert it to code or remove it and document why it's manual-only.

## Related

- Upstream PR: https://github.com/tiann/hapi/pull/682
- Upstream issues: #681 (readback unreliable), #680 (hardcoded Claude Code label — deferred)
