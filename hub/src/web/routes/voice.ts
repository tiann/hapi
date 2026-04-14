import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import {
    ELEVENLABS_API_BASE,
    VOICE_AGENT_NAME,
    buildVoiceAgentConfig
} from '@hapi/protocol/voice'

const tokenRequestSchema = z.object({
    customAgentId: z.string().optional(),
    customApiKey: z.string().optional()
})

const scribeTokenRequestSchema = z.object({
    customApiKey: z.string().optional()
})

const transcriptionModelSchema = z.enum(['scribe_v1', 'scribe_v2'])

const SUPPORTED_ELEVENLABS_LANGUAGE_CODES = new Set([
    'en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko',
    'pt', 'pt-br', 'it', 'es', 'id', 'nl', 'tr', 'pl', 'sv', 'bg',
    'ro', 'ar', 'cs', 'el', 'fi', 'ms', 'da', 'ta', 'uk', 'ru',
    'hu', 'hr', 'sk', 'no', 'vi', 'tl'
])

// Cache for auto-created agent IDs (keyed by API key hash)
const agentIdCache = new Map<string, string>()

interface ElevenLabsAgent {
    agent_id: string
    name: string
}

interface ElevenLabsTool {
    id: string
    tool_config?: {
        name?: string
        type?: string
    }
}

function normalizeTranscriptionLanguageCode(raw: string | null): string | undefined {
    if (!raw) return undefined

    const normalized = raw.trim().toLowerCase()
    if (!normalized) return undefined

    if (SUPPORTED_ELEVENLABS_LANGUAGE_CODES.has(normalized)) {
        return normalized
    }

    if (normalized === 'pt-br' || normalized.startsWith('pt-br-')) {
        return 'pt-br'
    }

    const base = normalized.split(/[-_]/)[0]
    if (base && SUPPORTED_ELEVENLABS_LANGUAGE_CODES.has(base)) {
        return base
    }

    return undefined
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

    app.post('/voice/transcribe', async (c) => {
        const formData = await c.req.formData().catch(() => null)
        if (!formData) {
            return c.json({ error: 'Invalid form data' }, 400)
        }

        const file = formData.get('file')
        const modelIdRaw = formData.get('modelId')
        const languageCodeRaw = formData.get('languageCode')

        if (!(file instanceof File)) {
            return c.json({ error: 'Missing audio file' }, 400)
        }

        const modelIdParsed = transcriptionModelSchema.safeParse(
            typeof modelIdRaw === 'string' ? modelIdRaw : 'scribe_v2'
        )
        if (!modelIdParsed.success) {
            return c.json({ error: 'Invalid modelId' }, 400)
        }

        const apiKey = process.env.ELEVENLABS_API_KEY
        if (!apiKey) {
            return c.json({ error: 'ElevenLabs API key not configured' }, 400)
        }

        const upstreamFormData = new FormData()
        upstreamFormData.set('model_id', modelIdParsed.data)
        upstreamFormData.set('file', file, file.name || 'speech.webm')
        const languageCode = typeof languageCodeRaw === 'string'
            ? normalizeTranscriptionLanguageCode(languageCodeRaw)
            : undefined
        if (languageCode && modelIdParsed.data === 'scribe_v2') {
            upstreamFormData.set('language_code', languageCode)
        }

        try {
            const response = await fetch(`${ELEVENLABS_API_BASE}/speech-to-text`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Accept': 'application/json'
                },
                body: upstreamFormData
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({})) as { detail?: { message?: string } | string; error?: string }
                const errorMessage = typeof errorData.detail === 'string'
                    ? errorData.detail
                    : errorData.detail?.message || errorData.error || `ElevenLabs API error: ${response.status}`
                return c.json({ error: errorMessage }, 500)
            }

            const data = await response.json() as { text?: string; language_code?: string }
            return c.json({
                text: data.text ?? '',
                languageCode: data.language_code
            })
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    app.post('/voice/scribe-token', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = scribeTokenRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid request body' }, 400)
        }

        const apiKey = parsed.data.customApiKey || process.env.ELEVENLABS_API_KEY
        if (!apiKey) {
            return c.json({ error: 'ElevenLabs API key not configured' }, 400)
        }

        try {
            const response = await fetch(`${ELEVENLABS_API_BASE}/single-use-token/realtime_scribe`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Accept': 'application/json'
                }
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({})) as { detail?: { message?: string } | string; error?: string }
                const errorMessage = typeof errorData.detail === 'string'
                    ? errorData.detail
                    : errorData.detail?.message || errorData.error || `ElevenLabs API error: ${response.status}`
                return c.json({ error: errorMessage }, 500)
            }

            const data = await response.json() as { token?: string }
            if (!data.token) {
                return c.json({ error: 'No token in ElevenLabs response' }, 500)
            }

            return c.json({ token: data.token })
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    return app
}
