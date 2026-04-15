import { realtimeClientTools } from '../realtimeClientTools'

/**
 * Gemini Live API function call from server.
 * Matches the `toolCall` shape in a BidiGenerateContent serverMessage.
 */
export interface GeminiFunctionCall {
    name: string
    args: Record<string, unknown>
    id: string
}

/**
 * Response sent back to Gemini Live via `toolResponse`.
 */
export interface GeminiFunctionResponse {
    name: string
    id: string
    response: { result: string }
}

type ClientToolHandler = (parameters: unknown) => Promise<string>

const toolHandlers: Record<string, ClientToolHandler> = {
    messageCodingAgent: realtimeClientTools.messageCodingAgent,
    processPermissionRequest: realtimeClientTools.processPermissionRequest
}

/**
 * Execute a Gemini Live function call using the existing client tool handlers.
 * Returns a GeminiFunctionResponse ready to send back over the WebSocket.
 */
export async function handleGeminiFunctionCall(
    call: GeminiFunctionCall
): Promise<GeminiFunctionResponse> {
    const handler = toolHandlers[call.name]

    if (!handler) {
        return {
            name: call.name,
            id: call.id,
            response: { result: `error (unknown tool: ${call.name})` }
        }
    }

    try {
        const result = await handler(call.args)
        return {
            name: call.name,
            id: call.id,
            response: { result }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error'
        return {
            name: call.name,
            id: call.id,
            response: { result: `error (${message})` }
        }
    }
}

/**
 * Process multiple function calls in parallel and return all responses.
 */
export async function handleGeminiFunctionCalls(
    calls: GeminiFunctionCall[]
): Promise<GeminiFunctionResponse[]> {
    return Promise.all(calls.map(handleGeminiFunctionCall))
}
