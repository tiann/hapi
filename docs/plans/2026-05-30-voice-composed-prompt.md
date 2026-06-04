# Voice advanced controls — composed prompt + bootstrap/stream

**Branch:** `feat/voice-advanced-controls`  
**Worktree:** `~/coding/hapi-voice-advanced-controls`  
**Latest:** composed prompt layers + bootstrap context stream (same branch as sliders / settings UI)

## What changed

- **Layered system prompt** (`shared/src/voicePromptLayers.ts`): fixtures (read-only) + provider guardrails + editable identity + character. Composed at runtime for ElevenLabs, Gemini Live, and Qwen.
- **Bootstrap + stream:** small `initialConversationContext` on connect; older history via `sendContextualUpdate` chunks (`voiceContextPlan.ts`). Gated by `hapi-voice-proactive` for spoken summary vs greet.
- **Settings:** identity/character editors, fixtures preview, wire-budget hints (`VoiceAdvancedControls.tsx`).

## Soup manifest (operator)

Keep (or add) in `~/.config/hapi/driver-manifest.yaml`:

```yaml
  - branch: feat/voice-advanced-controls
```

Then:

```bash
hapi-driver-rebuild --build-web --verify
hapi-use-driver   # when ready; prompts before restart
```

## Known follow-ups

- `voiceHooks.reportSession()` still uses `formatSessionFull` for mid-session focus — should chunk like connect.
- Gemini hub `?systemPrompt=` may drop composed prompt when URL exceeds ~12KB encoded — truncate or post-connect instruction.
- Payload-size integration test for ElevenLabs `startSession` total bytes.

## Test

```bash
cd ~/coding/hapi-voice-advanced-controls/shared && bun test src/voicePersonality.test.ts
cd ~/coding/hapi-voice-advanced-controls/web && bun test src/lib/voicePersonalitySession.test.ts src/realtime/hooks/voiceContextPlan.test.ts
cd ~/coding/hapi-voice-advanced-controls/web && bun run build
```
