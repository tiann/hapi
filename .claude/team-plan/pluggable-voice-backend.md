# Team Plan: Pluggable Voice Backend (ElevenLabs + Gemini Live)

## Overview

Refactor Hapi voice assistant into a pluggable architecture (Strategy Pattern) supporting ElevenLabs ConvAI (default) and Gemini Live API backends, switchable via `VOICE_BACKEND` env var. Minimize upstream file changes to reduce git pull conflicts.

## Codex Analysis Summary

- Existing `VoiceSession` interface + `registerVoiceSession()` is already a Strategy injection point
- `VOICE_BACKEND` should be resolved at runtime via hub API (not Vite env), since web frontend has no runtime env mechanism
- `sendContextualUpdate` has no Gemini Live equivalent; must approximate via `send_realtime_input` for incremental updates, `send_client_content` for initial context seeding
- Ephemeral tokens use `v1alpha` endpoint; regular API key uses `v1beta` — hub must handle this divergence
- Tool calling in Gemini Live requires synchronous `sendToolResponse`; existing `processPermissionRequest` involves async network calls — keep responses short
- Hidden coupling: `VoiceSessionConfig.language` is typed as `ElevenLabsLanguage` (types.ts:1)
- Settings page language list is ElevenLabs-specific (functions named `getElevenLabsSupportedLanguages`)

## Gemini Analysis Summary

- Proposed transparent proxy component pattern: `RealtimeVoiceSession` becomes a switcher
- Audio pipeline: capture via `getUserMedia` + `AudioWorkletNode` for 16kHz downsampling → PCM16 → base64 → WebSocket; playback via `AudioContext(24000)` with scheduled buffer queue
- Tool adapter needed: `getFunctionDeclarations()` maps existing client tools to Gemini format, `handleToolCall()` bridges execution
- Client VAD + server VAD hybrid for barge-in: clear playback queue immediately on interruption
- Settings page needs conditional rendering based on active backend
- No changes needed to `SessionChat.tsx`, `ComposerButtons.tsx`, `HappyThread.tsx` — they only consume abstract `useVoice()` status

## Functional Review Findings (v2)

### Critical Gaps Fixed
- C1: AudioWorklet processor file was missing → added to Task 4
- C2: Token expiry/reconnect not handled → added to Task 2 + Task 6
- C3: Session switching routes tool calls to wrong session → auto-stop on session switch
- C4: Voice component lifecycle / unmount cleanup → unified dispose() path in Task 6

### High Gaps Fixed
- H1: Mobile AudioContext blocked by autoplay → AudioContext created in user gesture handler
- H2: GEMINI_API_KEY missing behavior undefined → explicit error contract
- H3: Tool calling multi-call/timeout → serial execution + per-call timeout
- H4: React Strict Mode double-mount → useEffect cleanup
- H5: Voice button available before backend loads → voiceReady state gating

### Medium Gaps (addressed in Task 8/9)
- M1: Bundle size → React.lazy() dynamic import
- M2: Settings page not adapted → conditional rendering
- M3: No tests → added Task 8
- M4: No docs update → added Task 9

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend discovery | Hub runtime API (`GET /voice/backend`) | Web has no runtime env; avoids Vite rebuild to switch |
| Wrapper location | New `VoiceBackendSession.tsx` | Original `RealtimeVoiceSession.tsx` untouched = zero upstream conflict |
| Audio processing | Separate `gemini/` subdirectory | Isolate complexity; testable independently |
| Tool bridge | Adapter in `gemini/toolAdapter.ts` | Reuse existing `realtimeClientTools` without modification |
| Language type | Keep `ElevenLabsLanguage` for now | Gemini ignores language pref initially; refactor later to avoid upstream diff |
| Token flow | Hub creates ephemeral token for both backends | Never expose long-lived API keys to browser |
| Session switch | Auto-stop voice on session change | Prevents tool calls routing to wrong session |
| Gemini code loading | React.lazy() dynamic import | Zero bundle impact when using ElevenLabs |
| AudioContext creation | Synchronous in user gesture handler | Required for iOS/Android autoplay policy |

## Task List

### Task 1: Shared Voice Config Extension
- **Type**: Backend (shared)
- **File scope**:
  - `shared/src/voice.ts` (modify — append new exports)
- **Dependencies**: None
- **Implementation steps**:
  1. Add `VoiceBackendType = 'elevenlabs' | 'gemini-live'` and `DEFAULT_VOICE_BACKEND = 'elevenlabs'`
  2. Add `GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview'` constant
  3. Extract `VOICE_TOOL_DEFINITIONS` from existing `VOICE_TOOLS` — neutral format, single source of truth
  4. Add `buildGeminiLiveFunctionDeclarations()` — converts `VOICE_TOOL_DEFINITIONS` to Gemini `{ name, description, parameters }` schema format
  5. Add `buildGeminiLiveConfig()` — returns `{ model, systemInstruction: VOICE_SYSTEM_PROMPT, tools: [{ functionDeclarations }], responseModalities: ['AUDIO'] }` for `ai.live.connect()`
  6. Keep `buildVoiceAgentConfig()` untouched for ElevenLabs
- **Acceptance**: Both config builders produce valid configs; existing ElevenLabs flow unaffected; `VOICE_TOOL_DEFINITIONS` is the single source for both backends

### Task 2: Hub Backend Discovery + Token Route
- **Type**: Backend (hub)
- **File scope**:
  - `hub/src/web/routes/voice.ts` (modify — add routes, refactor handler)
  - `hub/package.json` (modify — add `@google/genai`)
- **Dependencies**: Task 1
- **Implementation steps**:
  1. Add `resolveVoiceBackend()`: reads `VOICE_BACKEND` env, validates against `VoiceBackendType`, defaults to `elevenlabs`
  2. Add `GET /voice/backend` route:
     - Success: `{ allowed: true, backend: VoiceBackendType }`
     - Failure (missing key): `{ allowed: false, backend: VoiceBackendType, code: 'missing_elevenlabs_api_key' | 'missing_gemini_api_key', error: string }`
     - Validates that the required API key exists for the configured backend
  3. Add `issueGeminiLiveToken()`:
     - Read `GEMINI_API_KEY ?? GOOGLE_API_KEY`; if missing, return `{ allowed: false, code: 'missing_gemini_api_key' }`
     - Use `@google/genai` SDK to create ephemeral token
     - Return `{ allowed: true, backend: 'gemini-live', token, model: GEMINI_LIVE_MODEL, apiVersion: 'v1alpha', expiresAt: number }`
     - Never cache Gemini tokens (they expire in ~60s)
  4. Refactor `POST /voice/token` handler:
     - Branch on `resolveVoiceBackend()` — `elevenlabs` uses existing logic unchanged, `gemini-live` calls `issueGeminiLiveToken()`
     - Discriminated union response type
  5. Error contract: all failure responses use `{ allowed: false, backend, code, error }` shape with appropriate HTTP status codes
  6. Add `@google/genai` to `hub/package.json`
- **Acceptance**: `GET /voice/backend` returns correct backend + allowed status; `POST /voice/token` returns valid token with `expiresAt` for Gemini; missing API key returns structured error; ElevenLabs path unchanged

### Task 3: Web API Types + Client Functions
- **Type**: Frontend (web)
- **File scope**:
  - `web/src/api/voice.ts` (modify — add types and fetch functions)
  - `web/src/api/client.ts` (modify — add fetchVoiceBackend method)
- **Dependencies**: Task 2
- **Implementation steps**:
  1. Add `VoiceBackendResponse` type:
     ```ts
     | { allowed: true; backend: VoiceBackendType }
     | { allowed: false; backend: VoiceBackendType; code: string; error: string }
     ```
  2. Extend `VoiceTokenResponse` as discriminated union:
     ```ts
     | { allowed: true; backend: 'elevenlabs'; token: string; agentId: string }
     | { allowed: true; backend: 'gemini-live'; token: string; model: string; apiVersion: string; expiresAt: number }
     | { allowed: false; backend: string; code: string; error: string }
     ```
  3. Add `fetchVoiceBackend(api)` function with module-level cache (cache only successful responses; invalidate on error)
  4. Add `fetchVoiceBackend()` method to `ApiClient` class
  5. Update `fetchVoiceToken()` to handle union response
- **Acceptance**: Type-safe API calls for both backends; cached backend discovery; failed responses not cached

### Task 4: Gemini Audio Pipeline
- **Type**: Frontend (web)
- **File scope** (all new files):
  - `web/src/realtime/gemini/pcmUtils.ts`
  - `web/src/realtime/gemini/pcm-recorder.worklet.ts`
  - `web/src/realtime/gemini/audioRecorder.ts`
  - `web/src/realtime/gemini/audioPlayer.ts`
- **Dependencies**: None (can parallel with Task 1-3)
- **Implementation steps**:
  1. `pcmUtils.ts`: Pure utility functions:
     - `float32ToPcm16(samples: Float32Array): ArrayBuffer`
     - `pcm16ToFloat32(buffer: ArrayBuffer): Float32Array`
     - `arrayBufferToBase64(buffer: ArrayBuffer): string`
     - `base64ToArrayBuffer(base64: string): ArrayBuffer`
  2. `pcm-recorder.worklet.ts`: AudioWorklet processor:
     - Extends `AudioWorkletProcessor`
     - `process()` method: accumulate Float32 samples into chunks (e.g., 4096 samples), post to main thread via `port.postMessage()`
     - Register as `'pcm-recorder-processor'`
     - Must be loadable via Vite: `import workletUrl from './pcm-recorder.worklet.ts?url'`
  3. `audioRecorder.ts`: class `GeminiAudioRecorder`:
     - `start(onChunk: (base64Pcm: string) => void)`:
       - `getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } })`
       - Create `AudioContext({ sampleRate: 16000 })`
       - `audioContext.audioWorklet.addModule(workletUrl)`
       - Connect MediaStreamSource → AudioWorkletNode
       - Worklet messages → `float32ToPcm16()` → `arrayBufferToBase64()` → `onChunk()`
     - `stop()`: stop all tracks, disconnect nodes, close AudioContext
     - `setMuted(muted: boolean)`: toggle `MediaStreamTrack.enabled`
     - `dispose()`: idempotent full cleanup, safe to call multiple times
     - Listen for `MediaStreamTrack.onended` (device unplugged) → invoke error callback
     - **Fallback**: if `audioWorklet.addModule()` fails, fall back to `ScriptProcessorNode` (deprecated but wider support)
  4. `audioPlayer.ts`: class `GeminiAudioPlayer`:
     - `constructor(audioContext?: AudioContext)`: use provided AudioContext or create new at 24kHz; maintain playback queue with scheduled end times
     - `enqueue(base64Pcm: string)`: decode → create `AudioBufferSourceNode` → schedule at `max(audioContext.currentTime, lastEndTime)` → update `lastEndTime`
     - `clearQueue()`: stop all scheduled sources immediately (for barge-in); reset `lastEndTime`
     - `isPlaying(): boolean`: check if audio is currently being output
     - `dispose()`: stop all, close AudioContext if we own it
     - Handle Chrome tab backgrounding: detect `audioContext.state === 'suspended'` → attempt `resume()` → if blocked, notify via callback
- **Acceptance**: Recorder produces 16kHz PCM16 base64 chunks; Player plays 24kHz PCM16 smoothly without clicks; clearQueue stops immediately; device unplug detected; fallback for no-AudioWorklet browsers

### Task 5: Gemini Tool Adapter
- **Type**: Frontend (web)
- **File scope** (new file):
  - `web/src/realtime/gemini/toolAdapter.ts`
- **Dependencies**: Task 1 (for VOICE_TOOL_DEFINITIONS)
- **Implementation steps**:
  1. `getGeminiFunctionDeclarations()`: import `VOICE_TOOL_DEFINITIONS` from shared (single source of truth), map to Gemini schema format — no separate declaration, no schema drift risk
  2. `handleGeminiToolCalls(functionCalls, clientTools)`:
     - Process calls **serially** (one at a time, in order)
     - For each call: lookup function name in `realtimeClientTools`, execute with args, collect result
     - **Preserve call IDs**: each `FunctionResponse` must include the matching `id` from the `FunctionCall`
     - **Per-call timeout**: wrap each execution in a 30s timeout; return `'error (timeout)'` on expiry
     - **Error isolation**: tool failure returns error string as response, never throws, never crashes session
     - Return `FunctionResponse[]` array
  3. `validateToolArgs(name: string, args: unknown): boolean`: basic validation that required params exist
- **Acceptance**: Function declarations derived from single source; tool calls route correctly; call IDs preserved in responses; timeout works; errors don't crash session

### Task 6: GeminiLiveVoiceSession Implementation
- **Type**: Frontend (web)
- **File scope** (new file):
  - `web/src/realtime/GeminiLiveVoiceSession.tsx`
  - `web/package.json` (modify — add `@google/genai`)
- **Dependencies**: Task 3, Task 4, Task 5
- **Implementation steps**:
  1. Create `GeminiLiveVoiceSessionImpl` class implementing `VoiceSession` interface:
     - **`startSession(config)`**:
       - Fetch token from hub via `fetchVoiceToken(api)`
       - Build config via `buildGeminiLiveConfig()` from shared
       - Call `ai.live.connect({ model, config, callbacks })` with ephemeral token
       - Start audio recorder → pipe chunks to live session via `sendRealtimeInput()`
       - Seed initial context via `session.sendClientContent()` (one-time)
       - Set status 'connected'
     - **`endSession()`**: call `dispose()` (see below)
     - **`sendTextMessage(message)`**: send as realtime text input to live session
     - **`sendContextualUpdate(update)`**: send as realtime text input with `[CONTEXT UPDATE] ` prefix
     - **`dispose(reason?: string)`**: single idempotent teardown path:
       - Stop recorder (releases mic)
       - Clear + dispose player
       - Close live session WebSocket
       - Reset all internal state
       - Safe to call from any failure branch, unmount, session switch, or error
     - **Reconnect logic**:
       - On WebSocket close/error: if `reason !== 'user-initiated'`, attempt reconnect
       - Fetch fresh token from hub (old one expired)
       - Recreate live session with new token
       - Reseed context via `sendClientContent()`
       - Max 3 reconnect attempts with exponential backoff (1s, 3s, 9s)
       - After 3 failures: set status 'error', show error in VoiceErrorBanner
  2. Create `GeminiLiveVoiceSession` React component:
     - Props: same as `RealtimeVoiceSessionProps`
     - **On mount**: instantiate impl, register via `registerVoiceSession()`, register session store
     - **useEffect cleanup**: call `dispose('unmount')` — handles React Strict Mode double-mount correctly
     - Handle `micMuted` prop: delegate to `recorder.setMuted()` — if recorder not yet started, store as pending state applied on recorder start
     - Wire live session callbacks:
       - `onopen` → status 'connected'
       - `onclose` → attempt reconnect or status 'disconnected'
       - `onerror` → status 'error' with message
       - `onmessage`: dispatch by type:
         - Audio data → `player.enqueue(base64)`
         - Tool call → `toolAdapter.handleGeminiToolCalls()` → `session.sendToolResponse()`
         - Text → log/ignore (voice session doesn't render text)
     - **Barge-in**: when server signals user is speaking (or audio input detected while player active) → `player.clearQueue()`
     - **AudioContext creation**: create AudioContext **synchronously in startSession**, which is called from user click handler → satisfies mobile autoplay policy
     - Share AudioContext between recorder and player where sample rates allow (otherwise separate contexts)
     - Render nothing (same as ElevenLabs version)
  3. Add `@google/genai` to `web/package.json`
- **Acceptance**: Full voice conversation works; tool calls execute correctly with preserved IDs; mic mute works (including pending state); barge-in clears playback; reconnect works on token expiry/WebSocket drop; dispose is idempotent; no resource leaks on unmount; works on mobile (AudioContext in gesture)

### Task 7: Voice Backend Switcher + Integration
- **Type**: Frontend (web)
- **File scope**:
  - `web/src/realtime/VoiceBackendSession.tsx` (new)
  - `web/src/realtime/index.ts` (modify — add export)
  - `web/src/components/SessionChat.tsx` (modify — change import + JSX, add auto-stop)
  - `web/src/lib/voice-context.tsx` (modify — add voiceReady state)
- **Dependencies**: Task 6
- **Implementation steps**:
  1. Create `VoiceBackendSession.tsx`:
     - Props: same as `RealtimeVoiceSessionProps` + `api: ApiClient`
     - On mount: call `fetchVoiceBackend(api)` (cached), store result in state
     - Render:
       - Loading (no backend yet): return null
       - `backend === 'gemini-live'` → `React.lazy(() => import('./GeminiLiveVoiceSession'))` wrapped in `<Suspense>`
       - Default → `<RealtimeVoiceSession {...props} />`
       - `allowed === false` → return null (voice not available)
  2. Update `web/src/lib/voice-context.tsx`:
     - Add `voiceReady: boolean` to context (default false)
     - Set `voiceReady = true` after backend discovery completes with `allowed: true`
     - Expose `voiceReady` in `useVoice()` return
     - Voice button disabled until `voiceReady === true`
  3. Update `web/src/components/SessionChat.tsx`:
     - Change import: `RealtimeVoiceSession` → `VoiceBackendSession`
     - Change JSX: `<RealtimeVoiceSession` → `<VoiceBackendSession`
     - Add auto-stop on session switch: when `props.session.id` changes while voice is active → call `stopVoice()`
     - No other changes to SessionChat logic
  4. Update `web/src/realtime/index.ts`: export `VoiceBackendSession`
- **Acceptance**: `VOICE_BACKEND=gemini-live` switches to Gemini; default uses ElevenLabs; UI behavior identical; voice button disabled during loading; auto-stop on session switch; Gemini code lazy-loaded (no bundle impact for ElevenLabs users)

### Task 8: Tests
- **Type**: Full-stack
- **File scope** (all new files):
  - `hub/src/web/routes/voice.test.ts`
  - `web/src/realtime/gemini/pcmUtils.test.ts`
  - `web/src/realtime/gemini/toolAdapter.test.ts`
  - `web/src/api/voice.test.ts`
- **Dependencies**: Task 7
- **Implementation steps**:
  1. Hub route tests (`voice.test.ts`):
     - `GET /voice/backend` returns correct backend for each `VOICE_BACKEND` value
     - `GET /voice/backend` returns `allowed: false` when API key missing
     - `POST /voice/token` returns ElevenLabs token shape when backend=elevenlabs
     - `POST /voice/token` returns Gemini token shape with expiresAt when backend=gemini-live
     - Error contract: all failures return `{ allowed, backend, code, error }`
  2. PCM utils tests:
     - Round-trip: `pcm16ToFloat32(float32ToPcm16(samples))` ≈ original (within quantization error)
     - Round-trip: `base64ToArrayBuffer(arrayBufferToBase64(buf))` === original
     - Edge cases: empty array, single sample, max int16 values
  3. Tool adapter tests:
     - `getGeminiFunctionDeclarations()` matches expected schema shape
     - `handleGeminiToolCalls()` routes to correct client tool
     - Call ID preserved in response
     - Timeout triggers error response (not throw)
     - Unknown tool name returns error response
  4. Web API voice tests:
     - `fetchVoiceBackend()` caches successful responses
     - `fetchVoiceBackend()` does not cache failures
     - `fetchVoiceToken()` returns correct union variant
- **Acceptance**: All tests pass; covers both backend paths; edge cases handled

### Task 9: Documentation + Settings
- **Type**: Frontend + Docs
- **File scope**:
  - `docs/guide/voice-assistant.md` (modify)
  - `web/src/routes/settings/index.tsx` (modify — conditional rendering)
- **Dependencies**: Task 7
- **Implementation steps**:
  1. Update `docs/guide/voice-assistant.md`:
     - Add "Backend Selection" section: `VOICE_BACKEND` env var, supported values, default
     - Add Gemini Live setup: `GEMINI_API_KEY` configuration
     - Keep existing ElevenLabs docs intact
     - Add comparison table (ElevenLabs vs Gemini Live)
     - Add troubleshooting: common Gemini errors, token expiry, mobile issues
  2. Update Settings page:
     - Fetch active backend via `fetchVoiceBackend()`
     - When `backend === 'gemini-live'`: hide voice language selector (Gemini ignores it)
     - Optionally show "Voice Backend: Gemini Live" indicator
- **Acceptance**: Docs cover both backends; Settings page doesn't show irrelevant options

## File Conflict Check

| File | Operation | Upstream Conflict Risk |
|------|-----------|----------------------|
| `shared/src/voice.ts` | Modify (append only) | Low — only adding exports |
| `hub/src/web/routes/voice.ts` | Modify (refactor handler) | Medium — actively maintained |
| `hub/package.json` | Modify (add dep) | Low |
| `web/src/api/voice.ts` | Modify (add types + function) | Low — append only |
| `web/src/api/client.ts` | Modify (add 1 method) | Low — append only |
| `web/src/lib/voice-context.tsx` | Modify (add voiceReady) | Low — add field |
| `web/src/components/SessionChat.tsx` | Modify (import swap + auto-stop) | Low-Medium |
| `web/src/realtime/index.ts` | Modify (add 1 export) | Low — append only |
| `web/src/routes/settings/index.tsx` | Modify (conditional render) | Low |
| `web/package.json` | Modify (add dep) | Low |
| `docs/guide/voice-assistant.md` | Modify (add sections) | Low |
| `web/src/realtime/GeminiLiveVoiceSession.tsx` | **New** | None |
| `web/src/realtime/VoiceBackendSession.tsx` | **New** | None |
| `web/src/realtime/gemini/audioRecorder.ts` | **New** | None |
| `web/src/realtime/gemini/audioPlayer.ts` | **New** | None |
| `web/src/realtime/gemini/pcmUtils.ts` | **New** | None |
| `web/src/realtime/gemini/pcm-recorder.worklet.ts` | **New** | None |
| `web/src/realtime/gemini/toolAdapter.ts` | **New** | None |
| `hub/src/web/routes/voice.test.ts` | **New** | None |
| `web/src/realtime/gemini/pcmUtils.test.ts` | **New** | None |
| `web/src/realtime/gemini/toolAdapter.test.ts` | **New** | None |
| `web/src/api/voice.test.ts` | **New** | None |

**Result**: 11 new files (zero conflict), 11 modified files (mostly append-only, 1-2 medium risk)

## Parallel Grouping

```
Layer 1 (parallel — 2 Builders):
  Task 1: shared config extension (no deps)
  Task 4: audio pipeline incl. worklet (no deps, pure utility)

Layer 2 (parallel — 2 Builders):
  Task 2: hub routes + token (depends on Task 1 types)
  Task 5: tool adapter (depends on Task 1 declarations)

Layer 3 (sequential):
  Task 3: web API types (depends on Task 2 response types)

Layer 4 (sequential):
  Task 6: Gemini session impl (depends on Task 3, 4, 5)

Layer 5 (sequential):
  Task 7: switcher + integration (depends on Task 6)

Layer 6 (parallel — 2 Builders):
  Task 8: tests (depends on Task 7)
  Task 9: docs + settings (depends on Task 7)
```

## Risk Matrix

| Risk | Severity | Mitigation |
|------|----------|------------|
| `sendContextualUpdate` semantic mismatch | High | Use `send_realtime_input` with `[CONTEXT UPDATE]` prefix; reduce voiceHooks noise |
| API key leaked to browser | High | Hub issues ephemeral token only; never pass long-lived key |
| Token expiry mid-session | High | Auto-reconnect with fresh token; max 3 retries; expiresAt in response |
| Session switch wrong routing | High | Auto-stop voice on session change in SessionChat |
| AudioWorklet browser compat | Medium | Fallback to ScriptProcessorNode if addModule() fails |
| Mobile autoplay blocked | Medium | Create AudioContext synchronously in user gesture; resume() before async ops |
| Audio pipeline complexity | Medium | Isolate in `gemini/` subdirectory; test recorder/player independently |
| Gemini Live API is preview | Medium | Centralize model name + API version in shared config; easy to update |
| Tool calling round-trip blocking | Medium | Serial execution; 30s per-call timeout; error isolation |
| React Strict Mode double-mount | Medium | useEffect cleanup calls dispose('unmount') |
| Chrome tab backgrounding | Low | Detect suspended AudioContext; attempt resume(); notify on failure |
| `hub/src/web/routes/voice.ts` merge conflict | Medium | Minimize structural changes; keep ElevenLabs path identical |

## Environment Variables

| Variable | Backend | Required | Default |
|----------|---------|----------|---------|
| `VOICE_BACKEND` | Both | No | `elevenlabs` |
| `ELEVENLABS_API_KEY` | ElevenLabs | When backend=elevenlabs | — |
| `ELEVENLABS_AGENT_ID` | ElevenLabs | No | Auto-created |
| `GEMINI_API_KEY` | Gemini Live | When backend=gemini-live | Falls back to `GOOGLE_API_KEY` |

## SESSION_ID (for /ccg:execute)
- CODEX_SESSION: 019d57bd-e452-7c80-8d67-d2b457b50086
- GEMINI_SESSION: 0ab98e48-a85f-458a-84b3-1e9e3e4a91da
