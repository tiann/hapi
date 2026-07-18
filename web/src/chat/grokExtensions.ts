import { isObject } from '@hapi/protocol'

const ROUTINE_GROK_EXTENSION_METHODS = new Set([
    '_x.ai/announcements/update',
    '_x.ai/mcp/init_progress',
    '_x.ai/mcp/servers_updated',
    '_x.ai/mcp_initialized',
    '_x.ai/settings/update',
    '_x.ai/sessions/changed',
    '_x.ai/queue/changed',
    '_x.ai/session/prompt_complete',
    '_x.ai/session_notification:tool_call_delta_chunk',
    'session/update:available_commands_update'
])

const ROUTINE_GROK_SESSION_MESSAGES = new Set([
    'Grok session_summary_generated',
    'Grok interaction_pending',
    'Grok interaction_resolved'
])

export type GrokExtensionDisplay =
    | { type: 'hidden' }
    | { type: 'event' }
    | { type: 'message'; message: string }

export function isGrokTelemetryStatusMessage(message: string): boolean {
    return message.includes('BatchSpanProcessor.ExportError')
        && message.includes('HTTP export failed')
}

export function shouldHideGrokSessionEventMessage(message: string): boolean {
    if (isGrokTelemetryStatusMessage(message) || ROUTINE_GROK_SESSION_MESSAGES.has(message)) {
        return true
    }
    return message.includes('responses API error')
        && message.includes('403 Forbidden')
        && message.includes("The model 'grok-build' requires a Grok subscription")
}

export function classifyGrokExtensionForDisplay(method: string, params: unknown): GrokExtensionDisplay {
    if (ROUTINE_GROK_EXTENSION_METHODS.has(method)) {
        return { type: 'hidden' }
    }

    if (method === '_x.ai/mcp/server_status') {
        if (isObject(params)) {
            const status = typeof params.status === 'string' ? params.status : ''
            const detail = typeof params.detail === 'string' ? params.detail : ''
            if (status === 'unavailable' && detail.startsWith('exhausted after')) {
                const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'server'
                return { type: 'message', message: `Grok MCP ${name} unavailable: ${detail}` }
            }
        }
        return { type: 'hidden' }
    }

    return { type: 'event' }
}
