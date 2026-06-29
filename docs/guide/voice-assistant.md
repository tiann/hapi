# Voice Assistant

Control your AI coding agent with voice using the built-in voice assistant powered by ElevenLabs Conversational AI.

## Overview

The voice assistant lets you:

- **Talk to your agent** - Ask questions, give instructions, and request code changes hands-free
- **Approve permissions by voice** - Say "yes" or "no" to approve or deny permission requests
- **Monitor progress** - Receive spoken updates when tasks complete or errors occur

The assistant bridges voice communication with your active coding agent (Claude Code, Codex, Gemini, or OpenCode), relaying your requests and summarizing responses in natural speech.

## Prerequisites

An [ElevenLabs](https://elevenlabs.io) account with API access

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

### 小米/MIUI 手机上麦克风授权失败

如果手机语音在小米/MIUI 设备上无法启动，或浏览器提示无法请求麦克风权限，请检查“小米钱包”等应用的「显示在其它应用上」权限。系统悬浮窗、支付/钱包浮层、聊天气泡、录屏、翻译、护眼或游戏助手等覆盖层可能会干扰浏览器的麦克风授权弹窗。关闭相关悬浮窗或覆盖层后，重新打开 HAPI 页面并再次授权麦克风。

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
