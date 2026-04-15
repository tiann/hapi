import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import {
    ELEVENLABS_API_BASE,
    VOICE_AGENT_NAME,
    buildVoiceAgentConfig,
    DEFAULT_VOICE_BACKEND
} from '@hapi/protocol/voice'
import type { VoiceBackendType } from '@hapi/protocol/voice'

const tokenRequestSchema = z.object({
    customAgentId: z.string().optional(),
    customApiKey: z.string().optional()
})

// Cache for auto-created agent IDs (keyed by API key hash)
const agentIdCache = new Map<string, string>()

interface ElevenLabsAgent {
    agent_id: string
    name: string
}

/**
 * Find an existing "Hapi Voice Assistant" agent
 */
async function findHapiAgent(apiKey: string): Promise<string | null> {
    try {
        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents`, {
            method: 'GET',
            headers: {
                'xi-api-key': apiKey,
                'Accept': 'application/json'
            }
        })

        if (!response.ok) {
            return null
        }

        const data = await response.json() as { agents?: ElevenLabsAgent[] }
        const agents: ElevenLabsAgent[] = data.agents || []
        const hapiAgent = agents.find(agent => agent.name === VOICE_AGENT_NAME)

        return hapiAgent?.agent_id || null
    } catch {
        return null
    }
}

/**
 * Create a new "Hapi Voice Assistant" agent
 */
async function createHapiAgent(apiKey: string): Promise<string | null> {
    try {
        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/create`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(buildVoiceAgentConfig())
        })

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({})) as { detail?: { message?: string } | string }
            const errorMessage = typeof errorData.detail === 'string'
                ? errorData.detail
                : (errorData.detail as { message?: string })?.message || `API error: ${response.status}`
            console.error('[Voice] Failed to create agent:', errorMessage)
            return null
        }

        const data = await response.json() as { agent_id?: string }
        return data.agent_id || null
    } catch (error) {
        console.error('[Voice] Error creating agent:', error)
        return null
    }
}

/**
 * Get or create agent ID - finds existing or creates new "Hapi Voice Assistant" agent
 */
async function getOrCreateAgentId(apiKey: string): Promise<string | null> {
    // Check cache first (simple hash of first/last chars of API key)
    const cacheKey = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
    const cached = agentIdCache.get(cacheKey)
    if (cached) {
        return cached
    }

    // Try to find existing agent
    console.log('[Voice] No agent ID configured, searching for existing agent...')
    let agentId = await findHapiAgent(apiKey)

    if (agentId) {
        console.log('[Voice] Found existing agent:', agentId)
    } else {
        // Create new agent
        console.log('[Voice] No existing agent found, creating new one...')
        agentId = await createHapiAgent(apiKey)
        if (agentId) {
            console.log('[Voice] Created new agent:', agentId)
        }
    }

    // Cache the result
    if (agentId) {
        agentIdCache.set(cacheKey, agentId)
    }

    return agentId
}

export function createVoiceRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Return the configured voice backend type
    app.get('/voice/backend', (c) => {
        const raw = process.env.VOICE_BACKEND
        const backend: VoiceBackendType =
            raw === 'gemini-live' ? 'gemini-live'
            : raw === 'qwen-realtime' ? 'qwen-realtime'
            : DEFAULT_VOICE_BACKEND
        return c.json({ backend })
    })

    // Get Gemini API key for Gemini Live voice sessions
    // Gemini Live API does not support ephemeral tokens, so we proxy the key.
    // The key is short-lived in the browser session and never persisted client-side.
    app.post('/voice/gemini-token', async (c) => {
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        if (!apiKey) {
            return c.json({
                allowed: false,
                error: 'Gemini API key not configured (set GEMINI_API_KEY or GOOGLE_API_KEY)'
            }, 400)
        }

        return c.json({
            allowed: true,
            apiKey,
            // Optional overrides for proxy/relay setups
            wsUrl: process.env.GEMINI_LIVE_WS_URL || undefined,
            baseUrl: process.env.GEMINI_API_BASE || undefined
        })
    })

    // Get Qwen (DashScope) API key for Qwen Realtime voice sessions
    app.post('/voice/qwen-token', async (c) => {
        const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
        if (!apiKey) {
            return c.json({
                allowed: false,
                error: 'DashScope API key not configured (set DASHSCOPE_API_KEY or QWEN_API_KEY)'
            }, 400)
        }

        return c.json({
            allowed: true,
            apiKey,
            wsUrl: process.env.QWEN_REALTIME_WS_URL || undefined
        })
    })

    // Get ElevenLabs ConvAI conversation token
    app.post('/voice/token', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = tokenRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ allowed: false, error: 'Invalid request body' }, 400)
        }

        const { customAgentId, customApiKey } = parsed.data

        // Use custom credentials if provided, otherwise fall back to env vars
        const apiKey = customApiKey || process.env.ELEVENLABS_API_KEY
        let agentId = customAgentId || process.env.ELEVENLABS_AGENT_ID

        if (!apiKey) {
            return c.json({
                allowed: false,
                error: 'ElevenLabs API key not configured'
            }, 400)
        }

        // Auto-create agent if not configured
        if (!agentId) {
            agentId = await getOrCreateAgentId(apiKey) ?? undefined
            if (!agentId) {
                return c.json({
                    allowed: false,
                    error: 'Failed to create ElevenLabs agent automatically'
                }, 500)
            }
        }

        try {
            // Fetch conversation token from ElevenLabs
            const response = await fetch(
                `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
                {
                    method: 'GET',
                    headers: {
                        'xi-api-key': apiKey,
                        'Accept': 'application/json'
                    }
                }
            )

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({})) as { detail?: { message?: string }; error?: string }
                const errorMessage = errorData.detail?.message || errorData.error || `ElevenLabs API error: ${response.status}`
                console.error('[Voice] Failed to get token from ElevenLabs:', errorMessage)
                return c.json({
                    allowed: false,
                    error: errorMessage
                }, 500)
            }

            const data = await response.json() as { token?: string }
            if (!data.token) {
                return c.json({
                    allowed: false,
                    error: 'No token in ElevenLabs response'
                }, 500)
            }

            return c.json({
                allowed: true,
                token: data.token,
                agentId
            })
        } catch (error) {
            console.error('[Voice] Error fetching token:', error)
            return c.json({
                allowed: false,
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    return app
}
