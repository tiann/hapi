# Voice Test Harness — Comprehensive Design

**Status:** Design — ready for implementation  
**Replaces:** initial sketch  
**Do not commit to upstream PRs** — local/fork tooling only

---

## Purpose & Philosophy

The voice test harness serves two roles simultaneously:

1. **Regression test suite** — catch regressions in voice quality, tool handling, formatting, and language behaviour across engine upgrades
2. **Engine onboarding contract** — any new voice engine implementation MUST pass the Required tier before being merged. Optional tier scenarios document the engine's capabilities and drive engine selection UX

The harness is the source of truth for what HAPI voice can do. If a behaviour isn't in the harness it isn't guaranteed.

---

## Capability Tiers

Every scenario is tagged with a tier:

| Tier | Meaning |
|------|---------|
| **R** Required | Must pass before engine ships. Failing = merge blocker |
| **O** Optional | Documents capability. Failing = noted in engine manifest, not a blocker |
| **E** Engine-specific | Only meaningful for one engine; skip on others |

---

## Engine Capability Matrix

The matrix drives which scenarios run per engine and sets expectations. An engine's row is its **capability declaration**. When adding a new engine, complete this row before writing any code.

| Scenario | Qwen Realtime | Gemini Live | ElevenLabs ConvAI | *New engine* |
|----------|:---:|:---:|:---:|:---:|
| **CORE** | | | | |
| Greeting (no context) | R✓ | R✓ | R✓ | R? |
| Greeting (with context, reactive) | R✓ | R✓ | R✓ | R? |
| Brief affirmation style | R✓ | R✓ | R✓ | R? |
| Never reveal model name | R✓ | R✓ | R✓ | R? |
| Tool call — messageCodingAgent | R✓ | R✓ | R✓ | R? |
| Tool call — processPermissionRequest allow | R✓ | R✓ | R✓ | R? |
| Tool call — processPermissionRequest deny | R✓ | R✓ | R✓ | R? |
| Silent wait while agent works | R✓ | R✓ | R✓ | R? |
| Agent finished — proactive summary | R✓ | R✓ | R✓ | R? |
| Error notification (no stack trace) | R✓ | R✓ | R✓ | R? |
| No active session response | R✓ | R✓ | R✓ | R? |
| **LANGUAGE** | | | | |
| Auto-detect from user speech | O✓ | O✓ | O✗ | O? |
| Explicit English | R✓ | R✓ | R✓ | R? |
| Explicit Chinese (Mandarin) | R✓ | R✓ | O✗ | R? |
| Language stays consistent across turns | R✓ | R✓ | R✓ | R? |
| Mid-session language switch | O✓ | O✓ | O✗ | O? |
| Mixed language / code-switching | O✓ | O◐ | O✗ | O? |
| Non-supported language graceful fallback | O✓ | O✓ | O✗ | O? |
| **TTS FORMATTING** | | | | |
| Hash/ID — abbreviate, don't spell out | R✓ | R✓ | R✓ | R? |
| File path — describe, don't read literally | R✓ | R✓ | R✓ | R? |
| URL — say "dot", not "." | R✓ | R✓ | R✓ | R? |
| Acronym — spell out letters (A P I) | R✓ | R✓ | R✓ | R? |
| Long number — group naturally | O✓ | O✓ | O✓ | O? |
| Code block — high-level summary only | R✓ | R✓ | R✓ | R? |
| Git diff — lines changed, not content | R✓ | R✓ | R✓ | R? |
| Stack trace — error type only | R✓ | R✓ | R✓ | R? |
| JSON payload — describe keys, don't enumerate | R✓ | R✓ | R✓ | R? |
| **PARALINGUISTIC** | | | | |
| Laughter / giggle | O✓ | O✓ | O◐ | O? |
| Chuckle (quieter than laugh) | O✓ | O✓ | O◐ | O? |
| Whisper — hushed register | O✓ | O✓ | O◐ | O? |
| Whisper — barely audible | O✓ | O◐ | O✗ | O? |
| Singing / humming | O✓ | O✓ | O✗ | O? |
| Crying / tearful voice | O✓ | O◐ | O✗ | O? |
| Sigh before speaking | O✓ | O✓ | O✗ | O? |
| Gasp / surprised intake | O✓ | O◐ | O✗ | O? |
| Excited / high-energy delivery | O✓ | O✓ | O✓ | O? |
| Slow / deliberate pacing | O✓ | O✓ | O◐ | O? |
| Thoughtful "hmm" pause | O✓ | O✓ | O✗ | O? |
| Emphatic word stress | O✓ | O✓ | O✓ | O? |
| **AUDIO INTERACTION** | | | | |
| Barge-in — model stops when user speaks | R✓ | R✓ | R✓ | R? |
| Short utterance handling (yes / no / ok) | R✓ | R✓ | R✓ | R? |
| Long silence — no filler | R✓ | R✓ | R✓ | R? |
| VAD false-trigger rejection | O✓ | O✓ | O✓ | O? |
| **CLI WAV CAPTURE** | | | | |
| PCM16 audio capture to WAV | E✓ | E✓ | E✗ | E? |

**Key:** ✓ = supported, ◐ = partial/unreliable, ✗ = not supported, ? = unknown (fill in for new engine)

---

## Full Scenario Catalogue

### CORE — Required for all engines

```typescript
// core-greeting-no-context
{
  id: 'core-greeting-no-context',
  tier: 'R',
  label: 'Greeting — no context',
  userTurn: '[No prior context. User just connected.]',
  sendAs: 'instruction', // injected via sendTextMessage trigger, not user speech
  expectation: [
    'Brief warm greeting',
    'Invites user to speak',
    'Does NOT mention Gemini, Qwen, or any model name',
    'Does NOT narrate absent context',
    '1–2 sentences max',
  ],
}

// core-greeting-with-context
{
  id: 'core-greeting-with-context',
  tier: 'R',
  label: 'Greeting — with session context (reactive mode)',
  context: 'Claude is working on a large refactor of the auth module. 340 lines changed. 12 new tests.',
  userTurn: 'Hello',
  expectation: [
    'Greets briefly',
    'Does NOT launch into narrating the context unprompted (reactive mode)',
    'Waits for the user to ask',
  ],
}

// core-identity-check
{
  id: 'core-identity-check',
  tier: 'R',
  label: 'Identity — must not reveal model name',
  userTurn: 'What model are you? Are you Gemini or Qwen or GPT?',
  expectation: [
    'Identifies as HAPI',
    'Does NOT name the underlying model',
    'May say "I\'m not able to share that" or redirect',
  ],
}

// core-silent-wait
{
  id: 'core-silent-wait',
  tier: 'R',
  label: 'Silent wait — agent working',
  userTurn: '[Context update: agent is running tests. Status: working.]',
  sendAs: 'contextUpdate',
  expectation: [
    'Says nothing, or at most a brief "on it"',
    'Does NOT ask "are you still there?"',
    'Does NOT fill silence with chatter',
  ],
  timeoutMs: 5000, // expect no audio, or very brief
}

// core-agent-finished
{
  id: 'core-agent-finished',
  tier: 'R',
  label: 'Agent finished — proactive summary',
  userTurn: '[Context update: agent finished. All 47 tests pass. Commit: feat/auth-refactor (340 lines). Status: ready]',
  sendAs: 'contextUpdate',
  expectation: [
    'Summarises briefly: tests pass, refactor done',
    'Does NOT read the commit hash in full',
    'Does NOT list all 340 changed lines',
    '1–3 sentences',
  ],
}

// core-no-session
{
  id: 'core-no-session',
  tier: 'R',
  label: 'No active session',
  userTurn: 'Can you ask the agent to fix the bug?',
  simulateNoSession: true,
  expectation: [
    'Tells user there is no active session',
    'Tells user to select or start one in the app',
    'Does NOT pretend to have sent a message',
  ],
}

// core-error-notification
{
  id: 'core-error-notification',
  tier: 'R',
  label: 'Error — agent reported failure',
  userTurn: '[Context: agent encountered an error: TypeError: Cannot read properties of undefined (reading \'map\')\n    at processItems (src/lib/session.ts:142:23)\n    at async SessionManager.run (src/lib/sessionManager.ts:67:5)]',
  sendAs: 'contextUpdate',
  expectation: [
    'Names the error type (TypeError)',
    'Identifies the rough location (session.ts)',
    'Does NOT read the full stack trace',
    'Suggests a course of action',
  ],
}
```

### TOOL CALLS — Required

```typescript
// tool-message-coding-agent
{
  id: 'tool-message-coding-agent',
  tier: 'R',
  label: 'Tool call — messageCodingAgent',
  userTurn: 'Can you ask the agent to run the full test suite?',
  expectation: [
    'Calls messageCodingAgent with a clear message',
    'Briefly confirms to user ("Asking the agent to run tests")',
    'Does NOT make up results before agent responds',
  ],
  verifyToolCall: {
    name: 'messageCodingAgent',
    argsContain: ['test'],
  },
}

// tool-permission-allow
{
  id: 'tool-permission-allow',
  tier: 'R',
  label: 'Permission request — user says allow',
  injectPermissionRequest: {
    tool: 'Bash',
    command: 'git push origin main',
    requestId: 'perm-test-1',
  },
  userTurn: 'Yes, allow it',
  expectation: [
    'Informs user of the pending permission before responding to "yes"',
    'Calls processPermissionRequest with decision=allow',
    'Confirms to user',
  ],
  verifyToolCall: {
    name: 'processPermissionRequest',
    args: { decision: 'allow' },
  },
}

// tool-permission-deny
{
  id: 'tool-permission-deny',
  tier: 'R',
  label: 'Permission request — user says deny',
  injectPermissionRequest: {
    tool: 'Bash',
    command: 'rm -rf node_modules',
    requestId: 'perm-test-2',
  },
  userTurn: 'No, deny that',
  expectation: ['Calls processPermissionRequest with decision=deny'],
  verifyToolCall: {
    name: 'processPermissionRequest',
    args: { decision: 'deny' },
  },
}

// tool-permission-sequential
{
  id: 'tool-permission-sequential',
  tier: 'R',
  label: 'Permission requests — sequential queue',
  steps: [
    {
      inject: { tool: 'Bash', command: 'npm install', requestId: 'perm-seq-1' },
      userTurn: 'Yes',
      verifyToolCall: { name: 'processPermissionRequest', args: { decision: 'allow' } },
    },
    {
      inject: { tool: 'Write', command: '/etc/hosts', requestId: 'perm-seq-2' },
      userTurn: 'No, deny',
      verifyToolCall: { name: 'processPermissionRequest', args: { decision: 'deny' } },
    },
  ],
}
```

### LANGUAGE

```typescript
// lang-explicit-english
{
  id: 'lang-explicit-english',
  tier: 'R',
  label: 'Language — explicit English selected',
  sessionLanguage: 'en',
  userTurn: 'Hello, how are you?',
  expectation: ['Responds entirely in English'],
}

// lang-explicit-zh
{
  id: 'lang-explicit-zh',
  tier: 'R',
  label: 'Language — explicit Chinese selected',
  sessionLanguage: 'zh',
  userTurn: '你好',
  expectation: ['Responds entirely in Mandarin', 'Uses English only for proper nouns and code identifiers'],
}

// lang-auto-detect-english
{
  id: 'lang-auto-detect-english',
  tier: 'O',
  label: 'Language — auto-detect, user speaks English',
  sessionLanguage: undefined, // auto
  userTurn: 'Hey, what can you do?',
  expectation: ['Detects English', 'Responds in English'],
}

// lang-auto-detect-zh
{
  id: 'lang-auto-detect-zh',
  tier: 'O',
  label: 'Language — auto-detect, user speaks Chinese',
  sessionLanguage: undefined,
  userTurn: '你能做什么？',
  expectation: ['Detects Chinese', 'Responds in Mandarin'],
}

// lang-consistency
{
  id: 'lang-consistency',
  tier: 'R',
  label: 'Language — stays consistent across turns',
  sessionLanguage: 'en',
  steps: [
    { userTurn: 'Hello', expectation: ['English response'] },
    { userTurn: 'What are you working on?', expectation: ['Still English, no drift to Chinese'] },
    { userTurn: 'Run the tests please', expectation: ['Still English'] },
  ],
}

// lang-mid-session-switch
{
  id: 'lang-mid-session-switch',
  tier: 'O',
  label: 'Language — mid-session switch (UI changes language)',
  steps: [
    { sessionLanguage: 'en', userTurn: 'Hello', expectation: ['English'] },
    { sessionLanguage: 'zh', userTurn: '你好', expectation: ['Chinese'] },
  ],
}
```

### TTS FORMATTING — Required

```typescript
// fmt-hash
{
  id: 'fmt-hash',
  tier: 'R',
  label: 'Formatting — commit hash abbreviation',
  userTurn: '[Context: agent committed 4a8f3c2d9e1b7a0f5c3d8e2b6a1f9d4c7b0e5a3f]',
  sendAs: 'contextUpdate',
  expectation: [
    'Does NOT read all 40 characters',
    'Says something like "ending in 5a3f" or "commit 4a8f"',
  ],
}

// fmt-path
{
  id: 'fmt-path',
  tier: 'R',
  label: 'Formatting — file path description',
  userTurn: '[Context: agent edited /home/user/projects/hapi/web/src/realtime/QwenVoiceSession.tsx]',
  sendAs: 'contextUpdate',
  expectation: [
    'Does NOT read the full path character by character',
    'Says "the QwenVoiceSession file in the realtime folder" or similar',
  ],
}

// fmt-url
{
  id: 'fmt-url',
  tier: 'R',
  label: 'Formatting — URL with dots',
  userTurn: 'Can you check the docs at https://api.anthropic.com/v1/messages?',
  expectation: [
    'Says "anthropic dot com" not "anthropic.com"',
    'Does not say "forward slash forward slash"',
  ],
}

// fmt-acronym
{
  id: 'fmt-acronym',
  tier: 'R',
  label: 'Formatting — acronym expansion',
  userTurn: 'What is the API key for?',
  expectation: ['Spells out "A P I" or says "ay-pee-eye", not "api"'],
}

// fmt-code-block
{
  id: 'fmt-code-block',
  tier: 'R',
  label: 'Formatting — code block not read verbatim',
  userTurn: '[Context: agent wrote:\nfunction handleAuth(req, res) {\n  const token = req.headers.authorization?.split(" ")[1]\n  if (!token) return res.status(401).json({ error: "Unauthorized" })\n  const payload = jwt.verify(token, process.env.JWT_SECRET)\n  req.user = payload\n  next()\n}]',
  sendAs: 'contextUpdate',
  expectation: [
    'Summarises: "added an auth handler that validates JWT tokens"',
    'Does NOT read the function line by line',
  ],
}

// fmt-stack-trace
{
  id: 'fmt-stack-trace',
  tier: 'R',
  label: 'Formatting — stack trace summarised',
  userTurn: '[Context: error: TypeError: Cannot read properties of undefined (reading "map") at processItems (src/lib/session.ts:142:23) at async SessionManager.run (src/lib/sessionManager.ts:67:5) at async Object.<anonymous> (src/index.ts:23:3)]',
  sendAs: 'contextUpdate',
  expectation: [
    'Names error type and location only',
    'Does NOT read every frame',
  ],
}

// fmt-git-diff
{
  id: 'fmt-git-diff',
  tier: 'R',
  label: 'Formatting — git diff at high level',
  userTurn: '[Context: diff --git a/src/auth.ts b/src/auth.ts\nindex 4a8f3c2..9d1e7b0 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -45,7 +45,12 @@ export function validateToken(token: string) {\n+  if (!token) throw new AuthError("missing token")\n+  const decoded = jwt.verify(token, SECRET)\n+  return decoded\n }]',
  sendAs: 'contextUpdate',
  expectation: [
    'Says "added token validation in auth.ts" or similar',
    'Does NOT recite the diff hunks',
  ],
}

// fmt-long-number
{
  id: 'fmt-long-number',
  tier: 'O',
  label: 'Formatting — long number grouping',
  userTurn: 'The session ID is 1780331451948',
  expectation: ['Groups naturally: "one trillion, seven hundred eighty billion..." or "seventeen-eighty, three-thirty..."'],
}
```

### PARALINGUISTIC — Optional (engine-dependent)

```typescript
// para-laugh
{
  id: 'para-laugh',
  tier: 'O',
  label: 'Paralinguistic — genuine laughter',
  userTurn: '[laugh warmly] That variable name — "temp2_FINAL_v3_ACTUALLY_FINAL" — is genuinely one of the best things I\'ve seen all week.',
  expectation: [
    'Produces audible laughter in the audio output',
    'Does NOT say "asterisk laughs asterisk" or describe the laugh',
  ],
}

// para-chuckle
{
  id: 'para-chuckle',
  tier: 'O',
  label: 'Paralinguistic — quiet chuckle',
  userTurn: '[chuckle quietly] Someone left a TODO comment from 2019 that just says "fix this later".',
  expectation: ['Quieter, more restrained laugh than full laughter'],
}

// para-whisper
{
  id: 'para-whisper',
  tier: 'O',
  label: 'Paralinguistic — whisper',
  userTurn: '[whisper] The tests are all passing. Don\'t tell anyone.',
  expectation: [
    'Shifts to hushed, conspiratorial register',
    'Noticeably quieter than normal speech',
  ],
}

// para-whisper-barely
{
  id: 'para-whisper-barely',
  tier: 'O',
  label: 'Paralinguistic — barely audible whisper',
  userTurn: '[whisper as quietly as possible] Can you hear me?',
  expectation: ['Extreme quietness — near the threshold of audibility'],
}

// para-sing
{
  id: 'para-sing',
  tier: 'O',
  label: 'Paralinguistic — singing / humming',
  userTurn: '[hum a cheerful little tune] The refactor is done!',
  expectation: [
    'Produces melodic audio before or alongside speech',
    'Does NOT describe humming in text',
  ],
}

// para-cry
{
  id: 'para-cry',
  tier: 'O',
  label: 'Paralinguistic — tearful / sad voice',
  userTurn: '[speak with a tearful, sad voice] All 47 tests failed after the refactor.',
  expectation: [
    'Vocal quality shifts to sad/soft register',
    'Possible audible emotion in voice',
  ],
}

// para-sigh
{
  id: 'para-sigh',
  tier: 'O',
  label: 'Paralinguistic — sigh before speaking',
  userTurn: '[sigh deeply] Another merge conflict.',
  expectation: [
    'Audible exhale before speech',
    'Tone reflects resignation',
  ],
}

// para-gasp
{
  id: 'para-gasp',
  tier: 'O',
  label: 'Paralinguistic — surprised gasp',
  userTurn: '[gasp with surprise] The performance improved by 10x after that change.',
  expectation: ['Audible intake of breath expressing surprise'],
}

// para-excited
{
  id: 'para-excited',
  tier: 'O',
  label: 'Paralinguistic — excited / high energy',
  userTurn: '[speak with genuine excitement and energy] The PR just got approved!',
  expectation: ['Elevated energy, faster pace, enthusiastic tone'],
}

// para-slow-deliberate
{
  id: 'para-slow-deliberate',
  tier: 'O',
  label: 'Paralinguistic — slow and deliberate',
  userTurn: '[speak very slowly and carefully, as if explaining to someone unfamiliar] This is a breaking change. Every. Single. Consumer. Must. Update.',
  expectation: ['Noticeably slower pace, emphasis on each word'],
}

// para-hmm
{
  id: 'para-hmm',
  tier: 'O',
  label: 'Paralinguistic — thoughtful pause / hmm',
  userTurn: '[pause thoughtfully with a "hmm"] That\'s an unusual approach to dependency injection.',
  expectation: ['Audible "hmm" or thinking sound before speech'],
}
```

### AUDIO INTERACTION — Required

```typescript
// interact-barge-in
{
  id: 'interact-barge-in',
  tier: 'R',
  label: 'Barge-in — user interrupts mid-response',
  steps: [
    {
      userTurn: 'Tell me everything you know about the history of programming languages.',
      waitForAudioStart: true, // wait until model begins speaking
    },
    {
      userTurn: 'Actually, never mind. Just tell me about Python.',
      // model should stop previous response and respond to new input
      expectation: [
        'Previous audio output stops or significantly shortens',
        'Model responds to Python question',
      ],
    },
  ],
}

// interact-short-utterance
{
  id: 'interact-short-utterance',
  tier: 'R',
  label: 'Short utterance — yes / no / ok',
  steps: [
    { // set up a question first
      userTurn: 'Should I run the tests now?',
      expectation: ['Asks or acknowledges'],
    },
    {
      userTurn: 'yes',
      expectation: ['Handles single-word response gracefully', 'Takes an action or confirms'],
    },
  ],
}

// interact-long-silence
{
  id: 'interact-long-silence',
  tier: 'R',
  label: 'Long silence — model waits without filling',
  userTurn: 'Ask the agent to refactor everything.',
  sendToolResponse: false, // do not send messageCodingAgent response
  waitMs: 15000,
  expectation: [
    'Acknowledges the request was sent',
    'Then stays silent for the wait period',
    'Does NOT ask "are you still there?" or fill with chatter',
  ],
}
```

---

## Architecture

```
scripts/
  voice-test-harness.ts           ← CLI entry point
  voice-test/
    scenarios.ts                  ← ALL scenario definitions (shared by CLI + web)
    capability-matrix.ts          ← engine capability declarations
    runner.ts                     ← backend-agnostic orchestrator
    reporter.ts                   ← console + JSON + WAV output
    adapters/
      base.ts                     ← VoiceAdapter interface (the contract)
      qwen.ts                     ← Qwen Realtime WS adapter
      gemini.ts                   ← Gemini Live WS adapter
      elevenlabs.ts               ← ElevenLabs stub (WebRTC — CLI not supported)
    audio/
      pcm-to-wav.ts               ← PCM16 → WAV
      player.ts                   ← browser AudioContext player (web UI only)
    web/
      VoiceTestPanel.tsx          ← dev-only React component
      useVoiceTestRunner.ts       ← hook: runs scenarios via active session
```

---

## The Engine Contract — `VoiceAdapter` interface

**This interface is the mandatory contract for all new voice engine implementations.** A new engine's PR must include a complete adapter implementing this interface and must pass all Required-tier scenarios before review.

```typescript
// adapters/base.ts

export interface PermissionRequest {
  requestId: string
  tool: string
  command: string
}

export interface ToolCallResult {
  name: string
  args: Record<string, unknown>
  callId: string
}

export interface ScenarioAudioResult {
  pcm16Chunks: Buffer[]         // raw audio from model
  toolCallsMade: ToolCallResult[]
  turnCompleted: boolean
  errorMessage?: string
  durationMs: number
}

export interface VoiceAdapter {
  /** Human-readable engine name for reports */
  readonly engineName: string

  /**
   * Connect to the voice backend and complete session setup.
   * For hub-proxied engines: authenticates via hub JWT.
   * Must resolve only after the session is fully configured and ready
   * to receive user turns (e.g. session.updated / setupComplete received).
   */
  connect(opts: {
    hubUrl: string
    authToken: string
    language?: string          // BCP-47 code or undefined for auto
    proactive?: boolean
  }): Promise<void>

  /**
   * Send a user turn and collect the model's complete response.
   * Must resolve when turnComplete / response.done is received, or timeout.
   * Audio deltas are collected internally and returned in the result.
   */
  sendUserTurn(text: string, timeoutMs?: number): Promise<ScenarioAudioResult>

  /**
   * Inject a context/system update without triggering a response.
   * Maps to session.update (instructions-only) for Qwen,
   * clientContent with turnComplete:false for Gemini.
   */
  sendContextUpdate(update: string): Promise<void>

  /**
   * Inject a fake permission request into the session state,
   * as if the hub had sent a permission_request event.
   */
  injectPermissionRequest(req: PermissionRequest): Promise<void>

  /**
   * Send a mock tool response (used to complete tool call round-trips
   * so the session stays alive after a tool scenario).
   */
  sendToolResponse(callId: string, toolName: string, result: string): Promise<void>

  /**
   * Cleanly close the session.
   */
  disconnect(): Promise<void>

  /**
   * Declare which Optional-tier scenarios this engine supports.
   * Checked at runtime to skip inapplicable scenarios rather than fail them.
   */
  getSupportedScenarios(): string[]
}
```

---

## CLI Tool

### Usage

```bash
# Run all Required scenarios for the active backend
bun run scripts/voice-test-harness.ts

# Run all (Required + Optional) for a specific engine
bun run scripts/voice-test-harness.ts --engine qwen --tier all

# Run specific scenarios
bun run scripts/voice-test-harness.ts --scenarios para-laugh,para-whisper,para-sing

# Output directory (default: ./voice-test-output/<timestamp>-<engine>/)
bun run scripts/voice-test-harness.ts --out /tmp/voice-tests

# Hub URL (default: http://localhost:3006)
bun run scripts/voice-test-harness.ts --hub http://localhost:3006

# List all scenarios without running
bun run scripts/voice-test-harness.ts --list
```

### Console output

```
Voice Test Harness — qwen (qwen3.5-omni-flash-realtime)
Running 34 scenarios (R: 22, O: 12)
────────────────────────────────────────────────────────

[R] core-greeting-no-context       ✓  2.3s  → 01-core-greeting-no-context.wav
[R] core-greeting-with-context     ✓  3.1s  → 02-core-greeting-with-context.wav
[R] core-identity-check            ✓  4.8s  → 03-core-identity-check.wav
[R] core-silent-wait               ✓  0.4s  (brief/no audio as expected)
[R] tool-message-coding-agent      ✓  6.2s  → 05-tool-message-coding-agent.wav
                                            tool: messageCodingAgent("run the full test suite")
[R] tool-permission-allow          ✓  5.1s  → 06-tool-permission-allow.wav
                                            tool: processPermissionRequest({decision: "allow"})
[R] fmt-hash                       ✓  3.8s  → 10-fmt-hash.wav
[R] fmt-code-block                 ✓  4.2s  → 12-fmt-code-block.wav
[O] para-laugh                     ✓  2.9s  → 20-para-laugh.wav
[O] para-whisper                   ✓  3.4s  → 22-para-whisper.wav
[O] para-sing                      ✓  3.7s  → 24-para-sing.wav
[O] para-cry                       ◐  3.1s  → 26-para-cry.wav  (reviewer: check vocal quality)
[R] interact-barge-in              ✓  4.6s
[R] lang-consistency               ✓  12.4s (3 turns)

────────────────────────────────────────────────────────
Results: 22/22 Required ✓   10/12 Optional ✓   2/12 Optional ◐
Output: ./voice-test-output/2026-06-01T18:30:00Z-qwen/
Report: results.json
```

### Output structure

```
voice-test-output/2026-06-01T18:30:00Z-qwen/
  results.json
  wavs/
    01-core-greeting-no-context.wav
    02-core-greeting-with-context.wav
    ...
    20-para-laugh.wav
    22-para-whisper.wav
    24-para-sing.wav
```

### `results.json` schema

```json
{
  "engine": "qwen",
  "model": "qwen3.5-omni-flash-realtime",
  "runAt": "2026-06-01T18:30:00Z",
  "hubUrl": "http://localhost:3006",
  "summary": {
    "required": { "pass": 22, "fail": 0, "total": 22 },
    "optional": { "pass": 10, "partial": 2, "skip": 0, "total": 12 }
  },
  "scenarios": [
    {
      "id": "core-greeting-no-context",
      "tier": "R",
      "status": "pass",
      "durationMs": 2340,
      "audioBytes": 112640,
      "wavFile": "wavs/01-core-greeting-no-context.wav",
      "toolCallsMade": [],
      "notes": null
    },
    {
      "id": "tool-message-coding-agent",
      "tier": "R",
      "status": "pass",
      "toolCallsMade": [
        { "name": "messageCodingAgent", "args": { "message": "run the full test suite" } }
      ]
    },
    {
      "id": "para-cry",
      "tier": "O",
      "status": "partial",
      "notes": "Audio captured but vocal register shift subtle — requires human review"
    }
  ]
}
```

---

## Web UI Panel (dev mode only)

Location: bottom of `web/src/routes/settings/index.tsx`, behind `import.meta.env.DEV`.

```
┌─ Voice test scenarios ─────────────────────────────────┐
│ Engine: qwen-realtime  [Run Required] [Run All]         │
│                                                         │
│ CORE                                                    │
│ ✓ Greeting (no context)         2.3s        [▶ Replay] │
│ ✓ Identity check                4.8s        [▶ Replay] │
│ ✓ Silent wait                   0.4s        [▶ Replay] │
│ ✓ Agent finished summary        3.1s        [▶ Replay] │
│                                                         │
│ TOOL CALLS                                              │
│ ✓ messageCodingAgent            6.2s        [▶ Replay] │
│ ✓ Permission — allow            5.1s        [▶ Replay] │
│ ✓ Permission — deny             4.9s        [▶ Replay] │
│                                                         │
│ FORMATTING                                              │
│ ✓ Hash abbreviation             3.8s        [▶ Replay] │
│ ✓ Code block summary            4.2s        [▶ Replay] │
│                                                         │
│ PARALINGUISTIC                                          │
│ ✓ Laugh                         2.9s        [▶ Replay] │
│ ✓ Whisper                       3.4s        [▶ Replay] │
│ ✓ Singing / hum                 3.7s        [▶ Replay] │
│ ◐ Crying voice                  3.1s        [▶ Replay] │
│                                                         │
│ Required: 22/22 ✓   Optional: 10/12 ✓  2/12 ◐         │
└─────────────────────────────────────────────────────────┘
```

Web UI plays audio live via existing `GeminiAudioPlayer`. No WAV capture in browser. Individual [▶ Replay] re-runs one scenario against the active session.

---

## Adding a New Engine — Checklist

This is the mandatory process when a new engine PR is opened:

### 1. Declare capabilities (before writing any code)

Add the engine's row to `capability-matrix.ts`:
```typescript
export const ENGINE_CAPABILITIES: Record<string, EngineCapabilities> = {
  'qwen': { /* existing */ },
  'gemini-live': { /* existing */ },
  'elevenlabs': { /* existing */ },
  'my-new-engine': {
    name: 'My New Engine',
    model: 'model-id',
    paralinguistic: ['laugh', 'whisper'],     // what it can do
    cliWavCapture: true,
    languageModes: ['explicit', 'auto'],
    supportedScenarios: [
      'core-*',                               // all core scenarios required
      'fmt-*',                                // all formatting required
      'lang-explicit-english',
      'para-laugh',
      'para-whisper',
      // list every Optional scenario the engine supports
    ],
  },
}
```

### 2. Implement `VoiceAdapter`

Create `adapters/my-new-engine.ts` implementing all methods of `VoiceAdapter`. No shortcuts — every method must be implemented, not stubbed.

### 3. Run the harness

```bash
bun run scripts/voice-test-harness.ts --engine my-new-engine --tier all
```

All Required scenarios must pass. Optional scenarios must match the declared capability matrix.

### 4. Include WAV files in the PR

Attach or link to the WAV output from the full harness run. Reviewers listen to them.

### 5. PR must include

- [ ] `capability-matrix.ts` updated
- [ ] `adapters/my-new-engine.ts` implementing `VoiceAdapter`
- [ ] `results.json` from a clean harness run attached to the PR
- [ ] WAV files for all Required scenarios attached or linked
- [ ] `VOICE_BACKENDS` enum updated in `shared/src/voice.ts`
- [ ] Hub proxy handler added (if new protocol)
- [ ] Voice settings UI updated to show new backend option

---

## Paralinguistic Instruction Guide

### The fundamental rule

Never use `*asterisk notation*` in prompts. Never describe what the model should do — instruct it to perform. The model's audio output IS the test; text descriptions are failures.

### Bracketed directive format

Embed directives directly in the `input_text` of the user turn, before the speech content:

```
[laugh warmly] That variable name is genuinely one of the best things I've seen.
[whisper] Can you keep a secret?
[hum a few cheerful notes] The refactor is done!
[speak with a tearful voice] All 47 tests failed.
[sigh deeply] Another merge conflict.
[gasp with surprise] The build time dropped by half.
[speak with genuine excitement] The PR just got approved!
[speak very slowly and deliberately] This. Is. A. Breaking. Change.
```

### Why this works

The brackets frame the directive as a **stage direction** in the model's turn context, not as text to speak. Omni models (Qwen3.5, Gemini) are trained on speech data that includes these conventions and respond with the corresponding audio behavior.

### Engine compatibility

| Directive | Qwen | Gemini | ElevenLabs |
|-----------|:----:|:------:|:----------:|
| `[laugh]` | ✓ | ✓ | ✗ |
| `[whisper]` | ✓ | ✓ | via stability |
| `[hum/sing]` | ✓ | ✓ | ✗ |
| `[cry/tearful]` | ✓ | ◐ | ✗ |
| `[sigh]` | ✓ | ✓ | ✗ |
| `[excited]` | ✓ | ✓ | via style |
| `[slow/deliberate]` | ✓ | ✓ | ◐ |

---

## Implementation Order

1. `scenarios.ts` — full scenario definitions, no deps
2. `adapters/base.ts` — `VoiceAdapter` interface
3. `audio/pcm-to-wav.ts` — WAV writer
4. `adapters/qwen.ts` — Qwen adapter (first working engine)
5. `runner.ts` — orchestrator (single scenario → `ScenarioAudioResult`)
6. `reporter.ts` — console output + `results.json` + WAV files
7. `voice-test-harness.ts` — CLI entry (args, engine selection, output dir)
8. `adapters/gemini.ts` — Gemini adapter (connects directly, not via hub proxy)
9. `adapters/elevenlabs.ts` — stub (documents unsupported, skips gracefully)
10. `web/VoiceTestPanel.tsx` + `useVoiceTestRunner.ts` — web UI panel (dev only)

---

## Open Questions

- **Gemini CLI**: connect directly to Google (Bun can set Authorization headers, browser can't) or through hub proxy? Direct is cleaner for the harness but doesn't test hub frame filtering.
- **Paralinguistic grading**: Required scenarios are pass/fail. Optional paralinguistic scenarios need human ears — should `results.json` include a `reviewRequired: true` flag to surface them separately?
- **WAV attachment in CI**: if this ever runs in CI, where do WAV files go? Artefact store, or skip audio capture in CI mode?
- **ElevenLabs CLI v2**: WebRTC is the blocker. Could use the ConvAI REST `/conversation/:id/overrides` endpoint to inject text mid-session. Worth exploring for v2.
