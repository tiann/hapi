import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { ListLocalSessionsRpcRequestSchema, type ListLocalSessionsRpcResponse } from '@hapi/protocol/localTranscript'
import { getLocalSessionSource } from './registry'
import type { LocalSessionHandlerDeps } from './types'

/**
 * Single machine RPC for local-session import: one method, one handler,
 * flavor selected in the request. Flavor readers register themselves in the
 * registry; handlers validate cwd policy and workspace roots exactly like
 * the previous per-flavor handlers did.
 */
export function registerLocalSessionHandlers(deps: LocalSessionHandlerDeps): void {
    deps.registerHandler<unknown, ListLocalSessionsRpcResponse>(
        RPC_METHODS.ListLocalSessions,
        async (params) => {
            const parsed = ListLocalSessionsRpcRequestSchema.safeParse(params)
            if (!parsed.success) return { success: false, error: 'Invalid local sessions request' }
            // A throwing reader (unreadable/corrupt local store) must surface
            // as a failed response, not as the RPC gateway's bare `{error}`
            // shape that fails the hub-side response schema parse.
            try {
                const source = getLocalSessionSource(parsed.data.flavor)
                if (!source) return { success: false, error: `No local session source registered for flavor: ${parsed.data.flavor}` }
                const rawCwd = typeof parsed.data.cwd === 'string' ? parsed.data.cwd.trim() : ''
                if (rawCwd) {
                    const resolvedCwd = await deps.resolveForCheck(rawCwd)
                    if (!deps.isWithinSpawnRoots(resolvedCwd)) {
                        return { success: false, error: 'Path is outside workspace roots' }
                    }
                }
                const requestedIds = parsed.data.sessionIds ? new Set(parsed.data.sessionIds) : null
                const listed = await source.list({ cwd: rawCwd || null, sessionIds: requestedIds ? [...requestedIds] : null })
                const sessions = []
                for (const session of listed) {
                    if (await deps.isSessionWithinWorkspaceRoots(session)) sessions.push(session)
                }
                return { success: true, sessions }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Failed to list local sessions' }
            }
        }
    )
}