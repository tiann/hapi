# Voice input and assistant

Control your AI coding agent with your voice. The built-in voice assistant supports three backends: **ElevenLabs** Conversational AI, **Gemini Live**, and **Qwen Realtime**. Pick whichever provider you have credentials for — the hub detects what's configured and the web app lets you switch.

For speech-to-text without a spoken assistant, open **Settings → Voice**, choose **Dictation**, then select a configured provider. Dictation records until you tap the microphone again, inserts the transcript into the composer, and never sends it automatically. Standard mode is the default. Realtime mode shows a live transcript while you speak and inserts the final result when you stop.

Dictation and voice-assistant provider credentials can be added in **Settings → Voice** (saved on the hub, masked in the UI). Environment variables still win when set at process start, and remain the preferred ops/bootstrap path:

```bash
# Voice assistant backends (any of these enables the assistant)
export ELEVENLABS_API_KEY="..."       # ElevenLabs ConvAI
export GEMINI_API_KEY="..."           # Gemini Live (GOOGLE_API_KEY also works)
export DASHSCOPE_API_KEY="..."        # Qwen Realtime (QWEN_API_KEY also works)

# Optional: pin the hub's default assistant backend
export VOICE_BACKEND="elevenlabs"     # elevenlabs | gemini-live | qwen-realtime

# Dictation transcription providers (pick any you use)
export OPENAI_API_KEY="..."           # gpt-transcribe / gpt-live-transcribe
export ELEVENLABS_API_KEY="..."       # scribe_v2 / scribe_v2_realtime
export DEEPGRAM_API_KEY="..."         # nova-3 standard / realtime
export GROQ_API_KEY="..."             # whisper-large-v3

# Or an OpenAI-compatible local server such as Speaches
export TRANSCRIPTION_BASE_URL="http://127.0.0.1:8000/v1"
export TRANSCRIPTION_MODEL="Systran/faster-whisper-large-v3"
export TRANSCRIPTION_API_KEY="..."    # optional
```

Settings-managed keys apply immediately (no hub restart). Restart is only required when you change process environment variables outside the UI. API keys are never returned in full to the browser.
Realtime OpenAI, ElevenLabs, and Deepgram dictation sessions receive only short-lived credentials minted by the hub. Gemini Live and Qwen Realtime assistant sessions connect through hub-side WebSocket proxies, so those API keys never reach the browser either. Eligible desktop browsers with the on-device `SpeechRecognition` API expose **Browser on-device** as a realtime-only dictation provider. HAPI checks the selected language pack when dictation starts and never falls back from that option to browser-hosted recognition. Mobile and unknown browser environments fail closed because this API is experimental and some Android WebViews expose unsafe partial implementations.

## Overview

The voice assistant lets you:

- **Talk to your agent** - Ask questions, give instructions, and request code changes hands-free
- **Approve permissions by voice** - Say "yes" or "no" to approve or deny permission requests
- **Monitor progress** - Receive spoken updates when tasks complete or errors occur

The assistant bridges voice communication with your active coding session, whatever agent flavor it runs. It relays your requests to the agent and summarizes responses in natural speech.

## Prerequisites

You need API credentials for at least one assistant backend:

- **ElevenLabs** - an [ElevenLabs](https://elevenlabs.io) account with API access
- **Gemini Live** - a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- **Qwen Realtime** - a DashScope API key from [Alibaba Cloud Model Studio](https://www.alibabacloud.com/help/en/model-studio/get-api-key)

Dictation needs at least one configured transcription provider from the list above, or an OpenAI-compatible local server.

## Setup

### ElevenLabs

1. Sign up or log in at [elevenlabs.io](https://elevenlabs.io)
2. Go to [API Keys](https://elevenlabs.io/app/settings/api-keys) in your account settings
3. Create a new API key and copy it
4. Set the environment variable before starting the hub:

```bash
export ELEVENLABS_API_KEY="your-api-key"
hapi hub --relay
```

The hub automatically creates a "Hapi Voice Assistant" agent in your ElevenLabs account on first use. When you pick a non-default voice, the hub creates a dedicated per-voice agent named `Hapi Voice Assistant [voice:<id>]` so the selection always takes effect.

To use your own ElevenLabs agent instead of the auto-created one:

```bash
export ELEVENLABS_AGENT_ID="your-agent-id"
```

To map specific voices to your own agents (overrides per-voice auto-creation):

```bash
export ELEVENLABS_VOICE_AGENT_MAP='{"<voice-id>": "<agent-id>"}'
```

### Gemini Live

```bash
export GEMINI_API_KEY="your-api-key"   # or GOOGLE_API_KEY
hapi hub --relay
```

### Qwen Realtime

```bash
export DASHSCOPE_API_KEY="your-api-key"   # or QWEN_API_KEY
hapi hub --relay
```

When more than one backend is configured, the hub default is ElevenLabs unless you set `VOICE_BACKEND`. Users can override the backend per browser in **Settings → Voice**.

## Usage

### Starting a Voice Session

1. Open a session in the web app
2. Click the **microphone button** in the composer (the send button shows a mic icon when the composer is empty)
3. Grant microphone permission when prompted
4. Start speaking

While the assistant is connected, a voice pill in the status bar shows its state (Connecting, Active, Muted, Error), and you can mute the microphone without ending the session.

### Voice Commands

| Say this | What happens |
|----------|--------------|
| "Ask Claude to..." / "Have it..." | Sends your request to the coding agent |
| "Refactor the auth module" | Coding requests are forwarded automatically |
| "Yes" / "Allow" / "Go ahead" | Approves pending permission requests |
| "No" / "Deny" / "Cancel" | Denies pending permission requests |
| Direct questions | The voice assistant answers itself if it can |

## Settings

Everything user-facing lives under **Settings → Voice**:

- **Voice mode** - Voice assistant (two-way conversation) or Dictation (speech-to-text only)
- **Voice backend** - ElevenLabs, Gemini Live, or Qwen Realtime (shown when the hub has more than one configured)
- **Voice Language** - Auto-detect or a specific language; shared by the assistant and dictation
- **Voice** - Pick the assistant's voice. ElevenLabs lists your account voices (including clones) with audio previews; Gemini Live and Qwen Realtime offer their built-in voice catalogs
- **Opening** (assistant) - "Greet me" for a simple hello, or "Brief me" for a spoken summary of recent agent activity when you connect
- **Response length** (assistant) - Brief, Balanced, or Detailed answers

**Settings → Voice → Advanced** additionally offers:

- **Persona & instructions** - Rename/rebrand the assistant and shape its character and speaking style (preset or custom text)
- **How it sounds** - ElevenLabs tuning sliders (stability, style, speed, similarity boost, speaker boost) and Gemini's affective dialog option
- **Voice diagnostics** - Check the composed system prompt size against per-backend wire limits, see truncation warnings and the last voice session's context notice, and preview the read-only platform rules

## How It Works

### Context Synchronization

The voice assistant automatically receives updates when:

- You focus on a session (full history is loaded)
- The agent sends messages or uses tools
- Permission requests arrive
- Tasks complete

You don't need to ask for status updates - the assistant proactively summarizes relevant changes.

### Tools

The voice assistant has two tools to interact with your coding agent, on every backend:

1. **messageCodingAgent** - Forwards your requests to the active agent
2. **processPermissionRequest** - Handles permission approvals and denials

### Architecture

ElevenLabs sessions stream audio over WebRTC directly to ElevenLabs; the hub only mints short-lived conversation tokens:

```
Browser → WebRTC → ElevenLabs ConvAI → Voice Assistant → HAPI Hub → Coding Agent
```

Gemini Live and Qwen Realtime sessions connect over WebSocket to a hub-side proxy, which injects the API key and session configuration server-side:

```
Browser → WebSocket → HAPI Hub proxy → Gemini Live / Qwen Realtime → Coding Agent
```

The voice connection uses WebRTC (ElevenLabs) or WebSocket (Gemini Live, Qwen Realtime) for low-latency audio streaming. The HAPI hub provides tokens and proxies and handles authentication; provider API keys never reach the browser.

## Tips

- **Be specific** - Clear, complete requests get better results
- **Wait for completion** - The assistant stays silent while the agent works, then summarizes results
- **Use natural language** - No special command syntax needed
- **Keep sessions focused** - One active session at a time for clearest context

## Troubleshooting

### "ElevenLabs API key not configured"

Set `ELEVENLABS_API_KEY` in your environment and restart the hub.

### "Gemini API key not configured"

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in your environment and restart the hub.

### "DashScope API key not configured"

Set `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`) in your environment and restart the hub.

### "Microphone permission denied"

- Check browser permissions for microphone access
- Ensure no other app is using the microphone
- Try refreshing the page

### Microphone permission fails on Xiaomi/MIUI devices

If voice cannot start on a Xiaomi/MIUI device, or the browser cannot request microphone permission, check the "Display over other apps" permission for Xiaomi Wallet and similar apps. Floating windows, payment or wallet overlays, chat bubbles, screen recorders, translation tools, eye-comfort tools, and game assistants may interfere with the browser's microphone permission prompt. Disable active overlays, reopen HAPI, and grant microphone access again.

### Voice not responding

- Verify the session is connected (green dot in status bar)
- Check that the voice status pill shows "Connecting..." or the active state
- Ensure you have a stable internet connection

### "Failed to create ElevenLabs agent automatically"

- Verify your API key is valid
- Check your ElevenLabs account has available quota
- Try setting a custom `ELEVENLABS_AGENT_ID`

### Poor audio quality

- Use a headset to avoid echo
- Reduce background noise
- Check your internet connection stability
