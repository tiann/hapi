# Voice input and assistant

Control your AI coding agent with voice using the built-in voice assistant powered by ElevenLabs Conversational AI.

For speech-to-text without a spoken assistant, open **Settings → Voice**, choose **Dictation**, then select a configured provider. Dictation records until you tap the microphone again, inserts the transcript into the composer, and never sends it automatically. Standard mode is the default. Realtime mode shows a live transcript while you speak and inserts the final result when you stop.

Provider credentials are read only from the hub's startup environment:

```bash
# Pick any providers you use
export OPENAI_API_KEY="..."          # gpt-transcribe / gpt-live-transcribe
export ELEVENLABS_API_KEY="..."      # scribe_v2 / scribe_v2_realtime
export DEEPGRAM_API_KEY="..."        # nova-3 standard / realtime
export GROQ_API_KEY="..."             # whisper-large-v3

# Or an OpenAI-compatible local server such as Speaches
export TRANSCRIPTION_BASE_URL="http://127.0.0.1:8000/v1"
export TRANSCRIPTION_MODEL="Systran/faster-whisper-large-v3"
export TRANSCRIPTION_API_KEY="..."    # optional
```

Restart the hub after changing credentials. API keys are not entered or stored in the web app.
Realtime OpenAI, ElevenLabs, and Deepgram sessions receive only short-lived credentials minted by the hub. Browsers with an installed on-device `SpeechRecognition` language pack also expose **Browser on-device** as a realtime-only provider; HAPI never falls back from that option to browser-hosted recognition.

## Overview

The voice assistant lets you:

- **Talk to your agent** - Ask questions, give instructions, and request code changes hands-free
- **Approve permissions by voice** - Say "yes" or "no" to approve or deny permission requests
- **Monitor progress** - Receive spoken updates when tasks complete or errors occur

The assistant bridges voice communication with your active coding agent (Claude Code, Codex, Cursor Agent, Grok Build, or OpenCode), relaying your requests and summarizing responses in natural speech.

## Prerequisites

- Voice assistant: an [ElevenLabs](https://elevenlabs.io) account with API access
- Dictation: at least one configured provider above, or an OpenAI-compatible local server

## Setup

### 1. Get an API Key

1. Sign up or log in at [elevenlabs.io](https://elevenlabs.io)
2. Go to [API Keys](https://elevenlabs.io/app/settings/api-keys) in your account settings
3. Create a new API key and copy it

### 2. Configure the Hub

Set the environment variable before starting the hub:

```bash
export ELEVENLABS_API_KEY="your-api-key"
hapi hub --relay
```

The hub automatically creates a "Hapi Voice Assistant" agent in your ElevenLabs account on first use.

### 3. (Optional) Custom Agent

If you want to use your own ElevenLabs agent instead of the auto-created one:

```bash
export ELEVENLABS_AGENT_ID="your-agent-id"
```

## Usage

### Starting a Voice Session

1. Open a session in the web app
2. Click the **microphone button** in the composer (or the send button when empty)
3. Grant microphone permission when prompted
4. Start speaking

### Voice Commands

| Say this | What happens |
|----------|--------------|
| "Ask Claude to..." / "Have it..." | Sends your request to the coding agent |
| "Refactor the auth module" | Coding requests are forwarded automatically |
| "Yes" / "Allow" / "Go ahead" | Approves pending permission requests |
| "No" / "Deny" / "Cancel" | Denies pending permission requests |
| Direct questions | The voice assistant answers itself if it can |

## How It Works

### Context Synchronization

The voice assistant automatically receives updates when:

- You focus on a session (full history is loaded)
- The agent sends messages or uses tools
- Permission requests arrive
- Tasks complete

You don't need to ask for status updates - the assistant proactively summarizes relevant changes.

### Tools

The voice assistant has two tools to interact with your coding agent:

1. **messageCodingAgent** - Forwards your requests to the active agent
2. **processPermissionRequest** - Handles permission approvals and denials

### Architecture

```
Browser → WebRTC → ElevenLabs ConvAI → Voice Assistant → HAPI Hub → Coding Agent
```

The voice connection uses WebRTC for low-latency audio streaming. The HAPI hub provides conversation tokens and handles authentication.

## Tips

- **Be specific** - Clear, complete requests get better results
- **Wait for completion** - The assistant stays silent while the agent works, then summarizes results
- **Use natural language** - No special command syntax needed
- **Keep sessions focused** - One active session at a time for clearest context

## Troubleshooting

### "ElevenLabs API key not configured"

Set `ELEVENLABS_API_KEY` in your environment and restart the hub.

### "Failed to get microphone permission"

- Check browser permissions for microphone access
- Ensure no other app is using the microphone
- Try refreshing the page

### Microphone permission fails on Xiaomi/MIUI devices

If voice cannot start on a Xiaomi/MIUI device, or the browser cannot request microphone permission, check the "Display over other apps" permission for Xiaomi Wallet and similar apps. Floating windows, payment or wallet overlays, chat bubbles, screen recorders, translation tools, eye-comfort tools, and game assistants may interfere with the browser's microphone permission prompt. Disable active overlays, reopen HAPI, and grant microphone access again.

### Voice not responding

- Verify the session is connected (green dot in status bar)
- Check that voice status shows "connecting" or connected state
- Ensure you have a stable internet connection

### "Failed to create ElevenLabs agent automatically"

- Verify your API key is valid
- Check your ElevenLabs account has available quota
- Try setting a custom `ELEVENLABS_AGENT_ID`

### Poor audio quality

- Use a headset to avoid echo
- Reduce background noise
- Check your internet connection stability
