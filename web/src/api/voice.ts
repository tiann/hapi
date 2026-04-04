/**
 * API functions for voice assistant integration.
 *
 * Fetches conversation tokens from the hub for ElevenLabs integration.
 * The hub handles authentication with ElevenLabs API, keeping credentials secure.
 *
 * Supports two modes:
 * 1. Default: Hub uses its own ElevenLabs credentials (production)
 * 2. Custom: Client provides their own ElevenLabs agent ID and API key
 */

import type { ApiClient } from './client'
import {
    ELEVENLABS_API_BASE,
    VOICE_AGENT_NAME,
    buildVoiceAgentConfig
} from '@hapi/protocol/voice'
import type { VoiceBackendType } from '@hapi/protocol/voice'

export interface VoiceTokenResponse {
    allowed: boolean
    token?: string
    agentId?: string
    error?: string
}

export interface VoiceTokenRequest {
    customAgentId?: string
    customApiKey?: string
}

/**
 * Fetch a conversation token from the hub for ElevenLabs voice sessions.
 *
 * This uses the private agent flow where:
 * 1. Hub holds the ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID (or uses user-provided ones)
 * 2. Hub fetches a short-lived conversation token from ElevenLabs
 * 3. Client uses this token to establish WebRTC connection
 */
export async function fetchVoiceToken(
    api: ApiClient,
    options?: VoiceTokenRequest
): Promise<VoiceTokenResponse> {
    try {
        return await api.fetchVoiceToken(options)
    } catch (error) {
        return {
            allowed: false,
            error: error instanceof Error ? error.message : 'Network error'
        }
    }
}

export interface ElevenLabsAgent {
    agent_id: string
    name: string
}

export interface FindAgentResult {
    success: boolean
    agentId?: string
    error?: string
}

export interface CreateAgentResult {
    success: boolean
    agentId?: string
    error?: string
    created?: boolean
}

/**
 * Find an existing "Hapi Voice Assistant" agent using the provided API key.
 */
export async function findHapiAgent(apiKey: string): Promise<FindAgentResult> {
    try {
        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents`, {
            method: 'GET',
            headers: {
                'xi-api-key': apiKey,
                'Accept': 'application/json'
            }
        })

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({})) as { detail?: { message?: string } | string }
            const errorMessage = typeof errorData.detail === 'string'
                ? errorData.detail
                : errorData.detail?.message || `API error: ${response.status}`
            return { success: false, error: errorMessage }
        }

        const data = await response.json() as { agents?: ElevenLabsAgent[] }
        const agents: ElevenLabsAgent[] = data.agents || []

        const hapiAgent = agents.find(agent => agent.name === VOICE_AGENT_NAME)

        if (hapiAgent) {
            return { success: true, agentId: hapiAgent.agent_id }
        } else {
            return { success: false, error: `No agent named "${VOICE_AGENT_NAME}" found` }
        }
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Network error' }
    }
}

/**
 * Create or update the "Hapi Voice Assistant" agent with our default configuration.
 */
export async function createOrUpdateHapiAgent(apiKey: string): Promise<CreateAgentResult> {
    try {
        const findResult = await findHapiAgent(apiKey)
        const existingAgentId = findResult.success ? findResult.agentId : null

        const agentConfig = buildVoiceAgentConfig()

        let response: Response
        let created = false

        if (existingAgentId) {
            response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${existingAgentId}`, {
                method: 'PATCH',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(agentConfig)
            })
        } else {
            response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/create`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(agentConfig)
            })
            created = true
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({})) as { detail?: { message?: string } | string }
            const errorMessage = typeof errorData.detail === 'string'
                ? errorData.detail
                : errorData.detail?.message || `API error: ${response.status}`
            return { success: false, error: errorMessage }
        }

        const data = await response.json() as { agent_id?: string }
        const agentId = existingAgentId || data.agent_id

        if (!agentId) {
            return { success: false, error: 'Failed to get agent ID from response' }
        }

        return { success: true, agentId, created }
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Network error' }
    }
}

// --- Pluggable voice backend API ---

export interface QwenTokenResponse {
    allowed: boolean
    apiKey?: string
    wsUrl?: string
    error?: string
}

/**
 * Fetch a DashScope API key from the hub for Qwen Realtime voice sessions.
 */
export async function fetchQwenToken(api: ApiClient): Promise<QwenTokenResponse> {
    try {
        return await api.fetchQwenToken()
    } catch (error) {
        return {
            allowed: false,
            error: error instanceof Error ? error.message : 'Network error'
        }
    }
}

export interface VoiceBackendResponse {
    backend: VoiceBackendType
}

export interface GeminiTokenResponse {
    allowed: boolean
    apiKey?: string
    wsUrl?: string
    baseUrl?: string
    error?: string
}

/**
 * Discover which voice backend the hub is configured to use.
 */
export async function fetchVoiceBackend(api: ApiClient): Promise<VoiceBackendResponse> {
    try {
        const result = await api.fetchVoiceBackend()
        const backend = result.backend === 'gemini-live' ? 'gemini-live'
            : result.backend === 'qwen-realtime' ? 'qwen-realtime'
            : 'elevenlabs'
        return { backend } as VoiceBackendResponse
    } catch {
        return { backend: 'elevenlabs' }
    }
}

/**
 * Fetch a Gemini API key from the hub for Gemini Live voice sessions.
 */
export async function fetchGeminiToken(api: ApiClient): Promise<GeminiTokenResponse> {
    try {
        return await api.fetchGeminiToken()
    } catch (error) {
        return {
            allowed: false,
            error: error instanceof Error ? error.message : 'Network error'
        }
    }
}
