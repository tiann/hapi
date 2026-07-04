/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage
} from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'
import type { ClaudePermissionMode } from '@hapi/protocol/types'

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    cwd: string
    version?: string
    gitBranch?: string
    parentUuid?: string | null
    // The model preset the session actually selected at launch time (e.g. "fable[1m]"),
    // with the `[1m]` suffix intact. Some 1M presets (fable[1m]) arrive on system/init
    // with the suffix already dropped ("claude-fable-5"), so this preserved preset is
    // the only turn-1 signal that such a session is 1M. Used only to seed the very first
    // contextWindow estimate before result.modelUsage confirms the real value.
    selectedModel?: string | null
}

type PermissionResponse = {
    approved: boolean
    mode?: ClaudePermissionMode
    reason?: string
}

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
        return branch || undefined
    } catch {
        return undefined
    }
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastUuid: string | null = null
    private context: ConversionContext
    private responses?: Map<string, PermissionResponse>
    private sidechainLastUUID = new Map<string, string>();
    // The model id from the most recent system/init. This is the session's authoritative
    // model and — crucially — is the exact string the CLI also uses as the key in
    // result.modelUsage, so it is what we both store the cache under and look it up by.
    private resolvedModel: string | null = null
    // Per-model contextWindow cache, keyed by the raw model id exactly as the CLI reports
    // it on system/init and in result.modelUsage. Those two always agree with each other
    // within a session (both bare for plain/fable[1m], both suffixed for opus[1m]/
    // sonnet[1m]); only the per-turn assistant message.model is bare and therefore lossy,
    // which is why lookups go through resolvedModel rather than the message's own model.
    // Keying per model — rather than a single sticky number — means a mid-session model
    // switch picks up the new model's own window immediately, and because keys are raw
    // (not suffix-normalized) a plain preset and its [1m] variant stay on distinct keys
    // even when they share a base id but have different windows on some tiers.
    private modelContextWindows = new Map<string, number>()

    constructor(
        context: Omit<ConversionContext, 'parentUuid'>,
        responses?: Map<string, PermissionResponse>
    ) {
        this.context = {
            ...context,
            gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
        this.responses = responses
    }

    /**
     * Update the originally-selected model hint (for when the session's model
     * changes mid-conversation, e.g. via the web model picker). `context.selectedModel`
     * is only a turn-1 seed hint (see the system/init handler in `convert()`), but the
     * caller (claudeRemoteLauncher) re-resolves the active mode -- including its model --
     * on every turn, not just the first, since a single long-running `claudeRemote()`
     * call keeps accepting new turns with a live-updatable mode. Without this update,
     * a mid-session switch would seed new models from a stale, session-start value:
     * switching *to* an 1M preset would under-seed (still guess 200k for its first
     * turn), and switching *away from* one would over-seed (guess 1M for a model that
     * isn't 1M-capable) until a result message corrects it.
     */
    updateSelectedModel(model: string | null | undefined): void {
        this.context.selectedModel = model ?? null
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastUuid = null
        this.context.parentUuid = null
    }

    /**
     * Convert rate_limit_event to pipe-delimited text matching the ACP path format,
     * or suppress if the status does not need display (e.g. 'allowed').
     * Must not mutate converter state (UUID chain) so dropped events are invisible.
     */
    private convertRateLimitEvent(sdkMessage: SDKMessage): RawJSONLines | null {
        const info = (sdkMessage as any).rate_limit_info
        if (typeof info !== 'object' || info === null) return null

        const { status, resetsAt, utilization, rateLimitType } = info

        if (status === 'allowed') return null
        if (typeof resetsAt !== 'number') return null

        const resetsAtInt = Math.round(resetsAt)
        let text: string

        if (status === 'allowed_warning') {
            const pct = typeof utilization === 'number' ? Math.round(utilization * 100) : 0
            const limitType = typeof rateLimitType === 'string' ? rateLimitType : ''
            text = `Claude AI usage limit warning|${resetsAtInt}|${pct}|${limitType}`
        } else if (status === 'rejected') {
            const limitType = typeof rateLimitType === 'string' ? rateLimitType : ''
            text = `Claude AI usage limit reached|${resetsAtInt}|${limitType}`
        } else {
            return null
        }

        const parentUuid = this.lastUuid
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.lastUuid = uuid

        return {
            parentUuid,
            isSidechain: false,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp,
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text }]
            }
        } as RawJSONLines
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        if (sdkMessage.type === 'rate_limit_event') {
            return this.convertRateLimitEvent(sdkMessage)
        }

        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        let parentUuid = this.lastUuid;
        let isSidechain = false;
        if (sdkMessage.parent_tool_use_id) {
            isSidechain = true;
            parentUuid = this.sidechainLastUUID.get((sdkMessage as any).parent_tool_use_id) ?? null;
            this.sidechainLastUUID.set((sdkMessage as any).parent_tool_use_id!, uuid);
        }
        const baseFields = {
            parentUuid: parentUuid,
            isSidechain: isSidechain,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp
        }

        let logMessage: RawJSONLines | null = null

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message
                }

                // Check if this is a tool result and add mode if available
                if (Array.isArray(userMsg.message.content)) {
                    for (const content of userMsg.message.content) {
                        if (content.type === 'tool_result' && content.tool_use_id && this.responses?.has(content.tool_use_id)) {
                            const response = this.responses.get(content.tool_use_id)
                            if (response?.mode) {
                                (logMessage as any).mode = response.mode
                            }
                        }
                    }
                } else if (typeof userMsg.message.content === 'string') {
                    // Simple string content, no tool result
                }
                break
            }

            case 'assistant': {
                const assistantMsg = sdkMessage as SDKAssistantMessage
                const message = assistantMsg.message as Record<string, unknown>
                // Look up the contextWindow by the session's resolved model (the last
                // system/init model), NOT the assistant message's own `model` field. The
                // message's model is always reported bare (no "[1m]"), so it can't tell a
                // 200k plain preset apart from its 1M "[1m]" variant on tiers where they
                // share a base id; resolvedModel preserves whichever spelling the CLI used
                // for the cache key. Using resolvedModel also means sidechain (Task
                // subagent) messages carry the MAIN session window rather than the
                // subagent's own — the web status bar's latestUsage picks the most recent
                // usage message without filtering sidechains (Claude usage carries no
                // scope_role), so a subagent's smaller window would otherwise make the
                // footer denominator visibly drop while it runs.
                const contextWindow = this.resolvedModel
                    ? this.modelContextWindows.get(this.resolvedModel)
                    : undefined
                if (contextWindow !== undefined && message && typeof message.usage === 'object' && message.usage !== null) {
                    const usage = message.usage as Record<string, unknown>
                    if (usage.context_window === undefined) {
                        usage.context_window = contextWindow
                    }
                }
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: assistantMsg.message,
                    // Assistant messages often have additional fields
                    requestId: (assistantMsg as any).requestId
                }
                // if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                //     for (const content of assistantMsg.message.content) {
                //         if (content.type === 'tool_use' && content.id) {
                //             this.sidechainLastUUID.set(content.id, uuid);
                //         }
                //     }
                // }
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage

                // System messages with subtype 'init' might update session ID
                if (systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                }

                // Capture the resolved model name on init. The remote launcher re-emits
                // system/init on every turn for the lifetime of this converter, so if we
                // already learned this model's real contextWindow from a previous result
                // message, leave it alone — recomputing a heuristic guess here would
                // downgrade an already-known-good value and is the exact cause of the
                // 200k<->1M flicker. Only seed a heuristic when this model has no cached
                // value yet (first time we see it in this session).
                if (systemMsg.subtype === 'init' && typeof systemMsg.model === 'string') {
                    this.resolvedModel = systemMsg.model
                    if (!this.modelContextWindows.has(systemMsg.model)) {
                        // Best-effort 1M-vs-200k seed for turn 1, before any authoritative
                        // result has arrived. `systemMsg.model` only tells us it's a 1M
                        // model for the presets whose init keeps the "[1m]" suffix
                        // (opus[1m]/sonnet[1m]); for others the init model is bare even
                        // when it's a 1M preset (fable[1m] -> "claude-fable-5"). So we
                        // primarily consult the originally-selected preset, which always
                        // preserves the suffix (e.g. "fable[1m]"), and fall back to the
                        // init model string. This selectedModel seed is load-bearing —
                        // without it, a fresh fable[1m] turn would flash 200k until the
                        // first result lands.
                        const seedIs1m = (this.context.selectedModel?.endsWith('[1m]') ?? false)
                            || systemMsg.model.endsWith('[1m]')
                        this.modelContextWindows.set(systemMsg.model, seedIs1m ? 1_000_000 : 200_000)
                    }
                }

                // System messages are typically not sent to logs
                // but we can convert them if needed
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    subtype: systemMsg.subtype,
                    model: systemMsg.model,
                    tools: systemMsg.tools,
                    // Include all other fields
                    ...(systemMsg as any)
                }
                break
            }

            case 'result': {
                // Result messages are not converted to log messages
                // They're SDK-specific messages that indicate session completion
                // Not part of the actual conversation log.
                //
                // But they carry the authoritative per-model contextWindow. modelUsage is
                // keyed by the same raw model id the CLI reports on system/init (and hence
                // the same id resolvedModel holds), so we cache each entry under that key
                // verbatim and inject it into subsequent assistant messages via
                // resolvedModel. Always overwrite on result — it is ground truth — for
                // every model reported, not just the currently-resolved one, so a model
                // switched away from earlier this session keeps its real value cached for
                // if/when the session switches back to it.
                const resultMsg = sdkMessage as SDKResultMessage
                if (resultMsg.modelUsage) {
                    for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
                        const cw = usage?.contextWindow
                        if (typeof cw === 'number' && cw > 0) {
                            this.modelContextWindows.set(model, cw)
                        }
                    }
                }
                break
            }

            // Handle tool use results (often comes as user messages)
            case 'tool_result': {
                const toolMsg = sdkMessage as any
                const baseLogMessage: any = {
                    ...baseFields,
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolMsg.tool_use_id,
                            content: toolMsg.content
                        }]
                    },
                    toolUseResult: toolMsg.content
                }

                // Add mode if available from responses
                if (toolMsg.tool_use_id && this.responses?.has(toolMsg.tool_use_id)) {
                    const response = this.responses.get(toolMsg.tool_use_id)
                    if (response?.mode) {
                        baseLogMessage.mode = response.mode
                    }
                }

                logMessage = baseLogMessage
                break
            }

            default:
                // Unknown message type - pass through with all fields
                logMessage = {
                    ...baseFields,
                    ...sdkMessage,
                    type: (sdkMessage as any).type // Override type last to ensure it's set
                } as any
        }

        // Update last UUID for parent tracking
        if (logMessage && logMessage.type !== 'summary') {
            this.lastUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }

    /**
     * Convert a simple string content to a sidechain user message
     * Used for Task tool sub-agent prompts
     */
    convertSidechainUserMessage(toolUseId: string, content: string): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.sidechainLastUUID.set(toolUseId, uuid);
        return {
            parentUuid: null,
            isSidechain: true,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            type: 'user',
            message: {
                role: 'user',
                content: content
            },
            uuid,
            timestamp
        }
    }

    /**
     * Generate an interrupted tool result message
     * Used when a tool call is interrupted by the user
     * @param toolUseId - The ID of the tool that was interrupted
     * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
     */
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"
        
        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastUuid
        
        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }
        
        const logMessage: RawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        } as any
        
        // Update last UUID for tracking
        this.lastUuid = uuid
        
        return logMessage
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage,
    context: Omit<ConversionContext, 'parentUuid'>,
    responses?: Map<string, PermissionResponse>
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context, responses)
    return converter.convert(sdkMessage)
}
