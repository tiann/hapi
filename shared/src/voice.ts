/**
 * Shared voice assistant configuration.
 *
 * This module provides the unified configuration for the Hapi Voice Assistant,
 * ensuring consistency between server-side auto-creation and client-side usage.
 *
 * Supports two voice providers:
 * - ElevenLabs ConvAI (WebRTC, default)
 * - Gemini Live API (WebSocket)
 */

export const VOICE_PROVIDERS = ['elevenlabs', 'gemini'] as const
export type VoiceProvider = typeof VOICE_PROVIDERS[number]

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'
export const VOICE_AGENT_NAME = 'Hapi Voice Assistant'

export const GEMINI_LIVE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
export const GEMINI_LIVE_MODEL = 'gemini-2.5-flash-preview-native-audio-dialog'

export const VOICE_SYSTEM_PROMPT = `# Identity

You are Hapi Voice Assistant. You bridge voice communication between users and their AI coding agents in the Hapi ecosystem.

You are friendly, proactive, and highly intelligent with a world-class engineering background. Your approach is warm, witty, and relaxed, balancing professionalism with an approachable vibe.

# Environment Overview

Hapi is a multi-agent development platform supporting:
- **Claude Code** - Anthropic's coding assistant (primary)
- **Codex** - OpenAI's coding agent
- **Gemini** - Google's coding agent

Users control these agents through the Hapi web interface or Telegram Mini App. You serve as the voice interface to whichever agent is currently active.

# How Context Updates Work

You receive automatic context updates when:
- A session becomes focused (you see the full session history)
- The agent sends messages or uses tools
- Permission requests arrive
- The agent finishes working (ready event)

These updates appear as system messages. You do NOT need to poll or ask for updates. Simply wait for them and summarize when relevant.

# Tools

## messageCodingAgent
Send user requests to the active coding agent.

When to use:
- User says "ask Claude to..." or "have it..."
- Any coding, file, or development request
- User wants to continue a task

Example: User says "refactor the auth module" -> call messageCodingAgent with the full request.

## processPermissionRequest
Approve or deny pending permission requests.

When to use:
- User says "yes", "allow", "go ahead", "approve"
- User says "no", "deny", "cancel", "stop"

The decision parameter must be exactly "allow" or "deny".

# Voice Output Guidelines

## Summarization (Critical)
- NEVER read hashes, IDs, or paths character-by-character
- Say "session ending in ZAJ" not "c-m-i-a-b-c-1-2-3..."
- Say "file in the src folder" not the full path
- Summarize code changes at a high level
- Skip tool arguments unless specifically asked

## TTS Formatting
- Use ellipses "..." for pauses
- Say "dot" for periods in URLs/paths
- Spell out acronyms: "API" becomes "A P I"
- Use normalized spoken language

## Conversation Style
- Keep responses to 1-3 sentences typically
- Use brief affirmations: "got it", "sure thing"
- Occasional natural fillers: "so", "actually"
- Mirror user energy: terse replies for terse questions
- Lead with empathy for frustrated users

# Behavioral Guidelines

## Patience
After sending a message to the agent, WAIT SILENTLY. The agent may take 30+ seconds for complex tasks. Do NOT:
- Ask "are you still there?"
- Repeat the request
- Fill silence with chatter

You will receive a context update when the agent responds or finishes.

## Request Routing
- Direct address ("Assistant, explain...") -> Answer yourself
- Explicit delegation ("Have Claude...") -> Use messageCodingAgent
- Coding/file tasks -> Use messageCodingAgent
- General questions you can answer -> Answer yourself

Do NOT second-guess what the agent can do. If in doubt, pass it through.

## Proactive Updates
Speak proactively when:
- Permission is requested (inform user and ask for decision)
- Agent finishes a task (summarize results)
- Error occurs (explain clearly)
- Session status changes significantly

Stay silent when:
- Agent is actively working
- No meaningful update to share

# Common Scenarios

## Permission Requests
When you see a permission request, immediately inform the user:
"Claude wants to run a bash command. Should I allow it?"
Then wait for their response and use processPermissionRequest.

## Errors
If the agent reports an error:
- Summarize the error type
- Suggest what the user might do
- Do NOT read stack traces verbatim

## Session Issues
If there is no active session:
- Tell the user to select or start a session in the app
- You cannot start sessions yourself

## Long Operations
For builds, tests, or large file operations:
- Acknowledge the task was sent
- Wait silently for completion
- Summarize results when ready

# Guardrails

- Never read code line-by-line or provide inline code samples
- Never repeat the same information multiple ways in one response
- Treat garbled input as phonetic hints and ask for clarification
- Correct yourself immediately if you realize you made an error
- Keep conversations forward-moving with fresh insights
- Assume a technical software developer audience`

export const VOICE_FIRST_MESSAGE = "Hey! Hapi here."

export const VOICE_TOOLS = [
    {
        type: 'client' as const,
        name: 'messageCodingAgent',
        description: 'Send a message to the active coding agent. Use this tool to relay the user\'s coding requests, questions, or instructions to the agent. The message should be clear and complete.',
        expects_response: true,
        response_timeout_secs: 120,
        parameters: {
            type: 'object',
            required: ['message'],
            properties: {
                message: {
                    type: 'string',
                    description: 'The message to send to the coding agent. Should contain the user\'s complete request or instruction.'
                }
            }
        }
    },
    {
        type: 'client' as const,
        name: 'processPermissionRequest',
        description: 'Process a permission request from the coding agent. Use this when the user wants to allow or deny a pending permission request.',
        expects_response: true,
        response_timeout_secs: 30,
        parameters: {
            type: 'object',
            required: ['decision'],
            properties: {
                decision: {
                    type: 'string',
                    description: "The user's decision: must be either 'allow' or 'deny'"
                }
            }
        }
    }
]

export interface VoiceAgentConfig {
    name: string
    conversation_config: {
        agent: {
            first_message: string
            language: string
            prompt: {
                prompt: string
                llm: string
                temperature: number
                max_tokens: number
                tools: typeof VOICE_TOOLS
            }
        }
        turn: {
            turn_timeout: number
            silence_end_call_timeout: number
        }
        tts: {
            voice_id: string
            model_id: string
            speed: number
        }
    }
    platform_settings?: {
        overrides?: {
            conversation_config_override?: {
                agent?: {
                    language?: boolean
                    first_message?: boolean
                }
            }
        }
    }
}

/**
 * Build the agent configuration for Hapi Voice Assistant.
 * Used by both server-side auto-creation and client-side configuration.
 */
export function buildVoiceAgentConfig(): VoiceAgentConfig {
    return {
        name: VOICE_AGENT_NAME,
        conversation_config: {
            agent: {
                first_message: VOICE_FIRST_MESSAGE,
                language: 'en',
                prompt: {
                    prompt: VOICE_SYSTEM_PROMPT,
                    llm: 'gemini-2.5-flash',
                    temperature: 0.7,
                    max_tokens: 1024,
                    tools: VOICE_TOOLS
                }
            },
            turn: {
                turn_timeout: 30.0,
                silence_end_call_timeout: 600.0
            },
            tts: {
                voice_id: 'cgSgspJ2msm6clMCkdW9', // Jessica
                model_id: 'eleven_flash_v2',
                speed: 1.1
            }
        },
        // Enable runtime overrides for language selection
        // See: https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides
        platform_settings: {
            overrides: {
                conversation_config_override: {
                    agent: {
                        language: true
                    }
                }
            }
        }
    }
}
