import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import {
    ELEVENLABS_API_BASE,
    VOICE_AGENT_NAME,
    buildVoiceAgentConfig,
    listConfiguredVoiceBackends,
    resolveHubVoiceBackend
} from '@hapi/protocol/voice'
import type { VoiceBackendType } from '@hapi/protocol/voice'

function buildVoiceWsUrl(base: string, pathname: string): string {
    const url = new URL(base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = pathname
    url.search = ''
    url.hash = ''
    return url.toString()
}

const tokenRequestSchema = z.object({
    customAgentId: z.string().optional(),
    customApiKey: z.string().optional(),
    voiceId: z.string().optional()
})

const telemetryEventSchema = z.object({
    stage: z.string().min(1),
    message: z.string().min(1),
    sessionId: z.string().optional(),
    voiceId: z.string().optional(),
    language: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional()
})

// Cache for auto-created agent IDs (keyed by API key hash)
const agentIdCache = new Map<string, string>()

// Per-process set of agent IDs that already had their platform_settings.overrides
// reconciled with the canonical buildVoiceAgentConfig() shape. Reset on process restart.
const overridesEnsuredAgents = new Set<string>()

interface ElevenLabsAgent {
    agent_id: string
    name: string
}

/**
 * Ensure an existing ElevenLabs ConvAI agent has the platform_settings.overrides
 * declared by buildVoiceAgentConfig(). Without these overrides, the client-side
 * SDK crashes with `Cannot read properties of undefined (reading 'error_type')`
 * when a session sends agent.prompt / tts.* override fields the server rejects.
 *
 * Idempotent and best-effort: PATCH failures are logged and swallowed so token
 * issuance is never blocked by reconciliation. Cached per agent_id per process.
 *
 * See: https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides
 */
async function ensureAgentOverrides(apiKey: string, agentId: string): Promise<void> {
    if (overridesEnsuredAgents.has(agentId)) return
    overridesEnsuredAgents.add(agentId)

    const canonical = buildVoiceAgentConfig().platform_settings
    if (!canonical) return

    try {
        const response = await fetch(
            `${ELEVENLABS_API_BASE}/convai/agents/${encodeURIComponent(agentId)}`,
            {
                method: 'PATCH',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ platform_settings: canonical })
            }
        )

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({})) as {
                detail?: { message?: string } | string
            }
            const errorMessage = typeof errorData.detail === 'string'
                ? errorData.detail
                : (errorData.detail as { message?: string })?.message
                || `API error: ${response.status}`
            console.warn('[Voice] Failed to ensure agent overrides (non-fatal)', {
                agentId,
                status: response.status,
                errorMessage
            })
            overridesEnsuredAgents.delete(agentId)
            return
        }

        console.log('[Voice] Reconciled platform_settings.overrides on agent', { agentId })
    } catch (error) {
        console.warn('[Voice] Error reconciling agent overrides (non-fatal)', {
            agentId,
            error: error instanceof Error ? error.message : String(error)
        })
        overridesEnsuredAgents.delete(agentId)
    }
}

function parseVoiceAgentMap(): Record<string, string> {
    const raw = process.env.ELEVENLABS_VOICE_AGENT_MAP
    if (!raw) return {}
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object') return {}
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
                .map(([k, v]) => [k, v as string])
        )
    } catch {
        return {}
    }
}

/**
 * Find an existing "Hapi Voice Assistant" agent
 */
async function findHapiAgent(apiKey: string, agentName: string = VOICE_AGENT_NAME): Promise<string | null> {
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
        const hapiAgent = agents.find(agent => agent.name === agentName)

        return hapiAgent?.agent_id || null
    } catch {
        return null
    }
}

/**
 * Create a new "Hapi Voice Assistant" agent
 */
async function createHapiAgent(apiKey: string): Promise<string | null> {
    return createNamedHapiAgent(apiKey, VOICE_AGENT_NAME)
}

async function createNamedHapiAgent(apiKey: string, agentName: string, voiceId?: string): Promise<string | null> {
    try {
        const config = buildVoiceAgentConfig()
        config.name = agentName
        if (voiceId) {
            config.conversation_config.tts.voice_id = voiceId
        }

        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/create`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(config)
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
    return getOrCreateAgentIdForVoice(apiKey)
}

function getVoiceAgentName(voiceId?: string): string {
    if (!voiceId || voiceId.trim().length === 0) return VOICE_AGENT_NAME
    return `${VOICE_AGENT_NAME} [voice:${voiceId}]`
}

async function getOrCreateAgentIdForVoice(apiKey: string, voiceId?: string): Promise<string | null> {
    // Check cache first (simple hash of first/last chars of API key)
    const cacheKey = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}::${voiceId ?? 'default'}`
    const cached = agentIdCache.get(cacheKey)
    if (cached) {
        return cached
    }

    const agentName = getVoiceAgentName(voiceId)

    // Try to find existing agent
    console.log('[Voice] No agent ID configured, searching for existing agent...', {
        voiceId,
        agentName
    })
    let agentId = await findHapiAgent(apiKey, agentName)

    if (agentId) {
        console.log('[Voice] Found existing agent:', agentId)
        // Existing agents may predate the platform_settings.overrides we declare
        // in buildVoiceAgentConfig() — reconcile so client overrides are accepted.
        await ensureAgentOverrides(apiKey, agentId)
    } else {
        // Create new agent
        console.log('[Voice] No existing agent found, creating new one...')
        agentId = await createNamedHapiAgent(apiKey, agentName, voiceId)
        if (agentId) {
            console.log('[Voice] Created new agent:', agentId)
            // Newly-created agents already carry the canonical overrides, but
            // mark as ensured so we don't re-PATCH on every token request.
            overridesEnsuredAgents.add(agentId)
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

    // Hub default backend + all backends with credentials configured
    app.get('/voice/backend', (c) => {
        const backends = listConfiguredVoiceBackends(process.env)
        const backend = resolveHubVoiceBackend(process.env)
        return c.json({ backend, backends })
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

        // Use server-side WS proxy to avoid region restrictions.
        // The proxy at /api/voice/gemini-ws handles the API key server-side.
        // Derive wsUrl from the request origin so remote browsers connect back to the hub,
        // not to localhost. HAPI_PUBLIC_URL overrides when set (e.g. behind a reverse proxy).
        const requestOrigin = new URL(c.req.url).origin
        const publicUrl = process.env.HAPI_PUBLIC_URL || requestOrigin
        const wsProxyUrl = buildVoiceWsUrl(publicUrl, '/api/voice/gemini-ws')

        return c.json({
            allowed: true,
            apiKey: 'proxied', // Dummy — key is handled server-side
            wsUrl: wsProxyUrl, // Always proxy — env WS URLs are upstream-only (server-side)
            baseUrl: process.env.GEMINI_API_BASE || undefined
        })
    })

    // Check Qwen (DashScope) availability for Qwen Realtime voice sessions
    // The actual API key is never sent to the browser — it stays server-side in the WS proxy.
    app.post('/voice/qwen-token', async (c) => {
        const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
        if (!apiKey) {
            return c.json({
                allowed: false,
                error: 'DashScope API key not configured (set DASHSCOPE_API_KEY or QWEN_API_KEY)'
            }, 400)
        }

        const requestOrigin = new URL(c.req.url).origin
        const publicUrl = process.env.HAPI_PUBLIC_URL || requestOrigin
        const wsProxyUrl = buildVoiceWsUrl(publicUrl, '/api/voice/qwen-ws')

        return c.json({
            allowed: true,
            wsUrl: wsProxyUrl // Always proxy — env WS URLs are upstream-only (server-side)
        })
    })

    // Get ElevenLabs ConvAI conversation token
    app.post('/voice/token', async (c) => {
        const requestId = crypto.randomUUID()
        const json = await c.req.json().catch(() => null)
        const parsed = tokenRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            console.warn('[Voice][Token] Invalid request body', { requestId })
            return c.json({ allowed: false, error: 'Invalid request body' }, 400)
        }

        const { customAgentId, customApiKey, voiceId } = parsed.data

        // Use custom credentials if provided, otherwise fall back to env vars
        const apiKey = customApiKey || process.env.ELEVENLABS_API_KEY
        const voiceAgentMap = parseVoiceAgentMap()
        const mappedAgentId = voiceId ? voiceAgentMap[voiceId] : undefined
        let agentId = customAgentId || mappedAgentId

        if (!apiKey) {
            console.warn('[Voice][Token] Missing API key', { requestId })
            return c.json({
                allowed: false,
                error: 'ElevenLabs API key not configured'
            }, 400)
        }

        // If a voice was selected and no explicit mapping/custom agent is set,
        // resolve/create a dedicated per-voice agent so selection always takes effect.
        if (!agentId && voiceId) {
            agentId = await getOrCreateAgentIdForVoice(apiKey, voiceId) ?? undefined
        }

        // Fallback to environment default agent only when no voice-specific route applies.
        if (!agentId) {
            agentId = process.env.ELEVENLABS_AGENT_ID
        }

        // Final fallback for setups without configured agent id.
        if (!agentId) {
            agentId = await getOrCreateAgentIdForVoice(apiKey, undefined) ?? undefined
        }

        if (!agentId) {
            console.error('[Voice][Token] Failed to resolve/create agent ID', { requestId })
            return c.json({
                allowed: false,
                error: 'Failed to create ElevenLabs agent automatically'
            }, 500)
        }

        // Operator-supplied agent ids (env ELEVENLABS_AGENT_ID, ELEVENLABS_VOICE_AGENT_MAP,
        // customAgentId) won't have been routed through ensureAgentOverrides above —
        // reconcile here so the client overrides payload is always accepted.
        await ensureAgentOverrides(apiKey, agentId)

        try {
            console.log('[Voice][Token] Requesting ElevenLabs conversation token', {
                requestId,
                agentId,
                voiceId,
                hasCustomAgentId: Boolean(customAgentId),
                hasMappedAgentId: Boolean(mappedAgentId),
                hasCustomApiKey: Boolean(customApiKey)
            })

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
                console.error('[Voice][Token] Failed to get token from ElevenLabs', {
                    requestId,
                    agentId,
                    status: response.status,
                    errorMessage
                })
                return c.json({
                    allowed: false,
                    error: errorMessage
                }, 500)
            }

            const data = await response.json() as { token?: string }
            if (!data.token) {
                console.error('[Voice][Token] Token response missing token field', {
                    requestId,
                    agentId
                })
                return c.json({
                    allowed: false,
                    error: 'No token in ElevenLabs response'
                }, 500)
            }

            console.log('[Voice][Token] Token issued successfully', { requestId, agentId })

            return c.json({
                allowed: true,
                token: data.token,
                agentId
            })
        } catch (error) {
            console.error('[Voice][Token] Error fetching token', {
                requestId,
                agentId,
                error: error instanceof Error ? error.message : String(error)
            })
            return c.json({
                allowed: false,
                error: error instanceof Error ? error.message : 'Network error'
            }, 500)
        }
    })

    // Get available ElevenLabs voices (includes user's voice clones)
    app.get('/voice/voices', async (c) => {
        const requestId = crypto.randomUUID()
        const apiKey = process.env.ELEVENLABS_API_KEY
        if (!apiKey) {
            console.warn('[Voice][Voices] Missing API key, returning empty voices list', { requestId })
            return c.json({ voices: [] })
        }

        try {
            const response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
                headers: {
                    'xi-api-key': apiKey,
                    'Accept': 'application/json'
                }
            })

            if (!response.ok) {
                console.error('[Voice][Voices] ElevenLabs voices request failed', {
                    requestId,
                    status: response.status
                })
                return c.json({ voices: [] })
            }

            const data = await response.json() as {
                voices?: Array<{
                    voice_id: string
                    name: string
                    preview_url: string
                    category: string
                }>
            }

            const voices = (data.voices ?? []).map(v => ({
                id: v.voice_id,
                name: v.name,
                previewUrl: v.preview_url,
                category: v.category
            }))

            console.log('[Voice][Voices] Voices fetched', {
                requestId,
                count: voices.length
            })

            return c.json({ voices })
        } catch (error) {
            console.error('[Voice][Voices] Unexpected error fetching voices', {
                requestId,
                error: error instanceof Error ? error.message : String(error)
            })
            return c.json({ voices: [] })
        }
    })

    app.post('/voice/telemetry', async (c) => {
        const requestId = crypto.randomUUID()
        const json = await c.req.json().catch(() => null)
        const parsed = telemetryEventSchema.safeParse(json ?? {})
        if (!parsed.success) {
            console.warn('[Voice][Telemetry] Invalid payload', { requestId })
            return c.json({ ok: false, error: 'Invalid telemetry payload' }, 400)
        }

        const { stage, message, sessionId, voiceId, language, details } = parsed.data
        console.log('[Voice][Telemetry]', {
            requestId,
            stage,
            message,
            sessionId,
            voiceId,
            language,
            details
        })

        return c.json({ ok: true })
    })

    return app
}
