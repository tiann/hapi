/**
 * Shared definitions for the peer-session MCP tools (`ping_peer`,
 * `spawn_peer`, `inspect_peer`, `list_peers`).
 *
 * Both the in-process HAPI MCP server (`startHappyServer`) and the
 * `hapi peer-tool <name>` CLI subcommand register/run these, so the schemas,
 * descriptions and result text cannot drift between the two entry points.
 */

import { z } from 'zod'
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol/modes'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import {
    INSPECT_PEER_TOOL_DESCRIPTION,
    LIST_PEERS_INCLUDE_INACTIVE_PARAM_DESCRIPTION,
    LIST_PEERS_TOOL_DESCRIPTION,
    PEER_DELIVERY_MODE_DESCRIPTION,
    PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION,
    PEER_WAKE_PARAM_DESCRIPTION,
    PING_PEER_TOOL_DESCRIPTION,
    SESSION_ID_PREFIX_PARAM_DESCRIPTION,
    SPAWN_PEER_TOOL_DESCRIPTION,
} from '@hapi/protocol/sessionCitation'
import { logger } from '@/ui/logger'
import { PeerDeliveryModeSchema, type PeerDeliveryMode } from './deliveryMode'
import {
    PingPeerError,
    formatInspectPeerReport,
    formatPeerSessionsList,
    forwardPeerReply,
    inspectPeer,
    listPeerSessions,
    peerListFetchLimit,
    pingPeer,
    supportsPeerReply,
} from './pingPeer'
import type { PeerParentIdentity } from '@hapi/protocol/peerParentStamp'
import { SpawnPeerError, spawnPeer } from '@/modules/spawnPeer/spawnPeer'

export type PeerToolName = 'ping_peer' | 'spawn_peer' | 'inspect_peer' | 'list_peers'

export type PeerToolDefinition = {
    title: string
    description: string
    inputSchema: z.ZodTypeAny
}

/** In MCP registration (and tools/list) order. */
export const PEER_TOOL_DEFINITIONS: Record<PeerToolName, PeerToolDefinition> = {
    ping_peer: {
        description: PING_PEER_TOOL_DESCRIPTION,
        title: 'Ping Peer Session',
        inputSchema: z.object({
            sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
            message: z.string().min(1).describe('Message text to deliver to the target session'),
            deliveryMode: PeerDeliveryModeSchema.optional().describe(PEER_DELIVERY_MODE_DESCRIPTION),
            wake: z.boolean().optional().describe(PEER_WAKE_PARAM_DESCRIPTION),
            waitForReply: z.boolean().optional().describe(PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION),
        }),
    },
    spawn_peer: {
        description: SPAWN_PEER_TOOL_DESCRIPTION,
        title: 'Spawn Peer Session',
        inputSchema: z.object({
            directory: z.string().trim().min(1)
                .describe('Working directory for the new session on the target machine (must exist there)'),
            message: z.string().min(1).describe('Required first user message (the remit). Empty spawn is a failed spawn.'),
            name: z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH).optional().describe('Session display name'),
            machine: z.string().trim().min(1).optional()
                .describe(
                    'Optional target runner: hub machine UUID or hostname (metadata.host / displayName from GET /api/machines). '
                    + 'Omit to spawn on this host.'
                ),
            agent: z.enum(CREATABLE_AGENT_FLAVORS as unknown as [string, ...string[]]).optional()
                .describe('Agent flavor override. When omitted, uses hub peerSpawnDefaults then stock claude.'),
            model: z.string().trim().min(1).optional()
                .describe('Model override for the resolved agent flavor.'),
            effort: z.string().trim().min(1).optional()
                .describe('Effort override (flavor-dependent).'),
            sessionType: z.enum(['simple', 'worktree']).optional()
                .describe('simple or worktree. Default simple (use directory as cwd). worktree creates a new tree from directory, which must be a git repository.'),
            permissionMode: PermissionModeSchema.optional()
                .describe(
                    'Permission mode for the new session. Omit to use hub/stock default (yolo). '
                    + 'Pass only to tighten or when the operator names a mode — do not clone the parent session.'
                ),
            waitForReply: z.boolean().optional().describe(PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION),
        }),
    },
    inspect_peer: {
        description: INSPECT_PEER_TOOL_DESCRIPTION,
        title: 'Inspect Peer Session',
        inputSchema: z.object({
            sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
            messageLimit: z.number().int().min(1).max(100).optional().describe(
                'Recent message page size (default 30, max 100). Text snippets only.'
            ),
        }),
    },
    list_peers: {
        description: LIST_PEERS_TOOL_DESCRIPTION,
        title: 'List Peer Sessions',
        inputSchema: z.object({
            limit: z.number().int().min(1).max(100).optional().describe(
                'Max sessions to return (default 30, max 100). Newest updatedAt first.'
            ),
            includeInactive: z.boolean().optional().describe(LIST_PEERS_INCLUDE_INACTIVE_PARAM_DESCRIPTION),
        }),
    },
}

export function isPeerToolName(name: string): name is PeerToolName {
    return Object.hasOwn(PEER_TOOL_DEFINITIONS, name)
}

export type PeerToolResult = {
    content: Array<{ type: 'text'; text: string }>
    isError: boolean
}

export type PeerToolContext = {
    /** Calling HAPI session: excluded from list_peers and target of forwarded replies. */
    callerSessionId?: string
    /** Resolved at call time so the MCP server reads the latest session metadata. */
    spawnContext: () => {
        cwd?: string
        /** `undefined` lets spawnPeer fall back to the HAPI_SESSION_* env. */
        parent?: PeerParentIdentity | null
        requireParent: boolean
    }
}

export type PeerToolHandlers = {
    ping_peer: (args: { sessionIdPrefix: string; message: string; deliveryMode?: PeerDeliveryMode; wake?: boolean; waitForReply?: boolean }) => Promise<PeerToolResult>
    spawn_peer: (args: {
        directory: string
        message: string
        name?: string
        machine?: string
        agent?: string
        model?: string
        effort?: string
        sessionType?: 'simple' | 'worktree'
        permissionMode?: string
        waitForReply?: boolean
    }) => Promise<PeerToolResult>
    inspect_peer: (args: { sessionIdPrefix: string; messageLimit?: number }) => Promise<PeerToolResult>
    list_peers: (args: { limit?: number; includeInactive?: boolean }) => Promise<PeerToolResult>
}

function errorMessage(error: unknown): string {
    return error instanceof PingPeerError || error instanceof SpawnPeerError
        ? error.message
        : error instanceof Error
            ? error.message
            : String(error)
}

function textResult(text: string, isError: boolean): PeerToolResult {
    return { content: [{ type: 'text' as const, text }], isError }
}

export function createPeerToolHandlers(ctx: PeerToolContext): PeerToolHandlers {
    /** Start reply forwarding when asked; returns the note for the tool result. */
    const forwardReplyIfRequested = (
        waitForReply: boolean | undefined,
        task: { sessionId: string; localId?: string; flavor?: string | null }
    ): string => {
        if (!waitForReply) return ''
        if (!task.localId) return '; the delivered message could not be identified, so check the reply with inspect_peer'
        if (!supportsPeerReply(task.flavor)) return `; ${task.flavor} peers do not report turn ends, so check the reply with inspect_peer`
        if (!ctx.callerSessionId) return '; no calling session (HAPI_SESSION_ID is unset), so check the reply with inspect_peer'
        forwardPeerReply({ peerSessionId: task.sessionId, taskLocalId: task.localId, callerSessionId: ctx.callerSessionId })
            .catch((error) => logger.debug('[hapiMCP] peer reply forwarding failed:', error))
        return '; its reply will be posted here'
    }

    return {
        ping_peer: async (args) => {
            logger.debug('[hapiMCP] ping_peer:', args.sessionIdPrefix)
            try {
                const result = await pingPeer({
                    sessionIdPrefix: args.sessionIdPrefix,
                    message: args.message,
                    deliveryMode: args.deliveryMode,
                    wake: args.wake === true,
                })
                const replyNote = forwardReplyIfRequested(args.waitForReply, result)
                return textResult(result.delivery === 'accepted'
                    ? `Accepted for ${result.sessionId}${result.resumed ? ' (resumed)' : ''} (${result.name}) localId=${result.localId} — delivery shows in the recipient chat when its runtime consumes it${result.steerNote ? ` (${result.steerNote})` : ''}${replyNote}`
                    : `${result.delivery} to ${result.sessionId}${result.resumed ? ' (resumed)' : ''} (${result.name}) localId=${result.localId}${replyNote}`, false)
            } catch (error) {
                const message = errorMessage(error)
                logger.debug('[hapiMCP] ping_peer failed:', message)
                return textResult(`Failed to ping peer: ${message}`, true)
            }
        },

        spawn_peer: async (args) => {
            logger.debug('[hapiMCP] spawn_peer:', args.directory, args.machine ? `machine=${args.machine}` : '')
            try {
                const spawnCtx = ctx.spawnContext()
                const result = await spawnPeer({
                    directory: args.directory,
                    cwd: spawnCtx.cwd,
                    message: args.message,
                    name: args.name,
                    machine: args.machine,
                    agent: args.agent as Parameters<typeof spawnPeer>[0]['agent'],
                    model: args.model,
                    effort: args.effort,
                    sessionType: args.sessionType,
                    permissionMode: args.permissionMode as Parameters<typeof spawnPeer>[0]['permissionMode'],
                    ...(spawnCtx.parent !== undefined ? { parent: spawnCtx.parent } : {}),
                    requireParent: spawnCtx.requireParent,
                })
                return textResult(`Spawned ${result.sessionId} (${result.name})${forwardReplyIfRequested(args.waitForReply, result)}`, false)
            } catch (error) {
                const message = errorMessage(error)
                logger.debug('[hapiMCP] spawn_peer failed:', message)
                return textResult(`Failed to spawn peer: ${message}`, true)
            }
        },

        inspect_peer: async (args) => {
            logger.debug('[hapiMCP] inspect_peer:', args.sessionIdPrefix)
            try {
                const result = await inspectPeer({
                    sessionIdPrefix: args.sessionIdPrefix,
                    messageLimit: args.messageLimit,
                })
                return textResult(formatInspectPeerReport(result), false)
            } catch (error) {
                const message = errorMessage(error)
                logger.debug('[hapiMCP] inspect_peer failed:', message)
                return textResult(`Failed to inspect peer: ${message}`, true)
            }
        },

        list_peers: async (args) => {
            logger.debug('[hapiMCP] list_peers')
            try {
                const limit = args.limit ?? 30
                const includeInactive = args.includeInactive === true
                const sessions = await listPeerSessions({
                    limit: peerListFetchLimit(limit, { excludeCaller: Boolean(ctx.callerSessionId) }),
                    includeInactive,
                })
                const peerCount = sessions.filter((session) => session.id !== ctx.callerSessionId).length
                return textResult(formatPeerSessionsList(sessions, {
                    maxRows: limit,
                    hasMore: peerCount > limit,
                    excludeSessionId: ctx.callerSessionId,
                    includeInactive,
                }), false)
            } catch (error) {
                const message = errorMessage(error)
                logger.debug('[hapiMCP] list_peers failed:', message)
                return textResult(`Failed to list peers: ${message}`, true)
            }
        },
    }
}
