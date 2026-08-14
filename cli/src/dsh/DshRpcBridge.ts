import { logger } from '@/ui/logger'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    DshActionSchema,
    type DshAgentPresetsResponse,
    type DshFeedbackResponse,
    type DshGoalResponse,
    type DshModelsResponse,
    type DshNativeHistoryResponse,
    type DshSelectModelResponse,
    type DshSkillsResponse,
    type DshSubagentCatalog
} from '@hapi/protocol'
import { DshClient } from './DshClient'
import { DshProjector } from './DshProjector'

export type DshRpcBridgeOptions = {
    client: DshClient
    dshSessionId: string
    workingDirectory: string
    rpcHandlerManager: RpcHandlerManager
    projector: DshProjector
    logTag?: string
}

/**
 * Registers the allowlisted session-scoped DSH RPC handlers.
 *
 * Every payload is validated against {@link DshActionSchema} before any DSH
 * wire call; there is no arbitrary method passthrough. Host-global surfaces
 * (settings/credentials/agent-preset authoring/…) are intentionally absent.
 */
export function registerDshRpcHandlers(options: DshRpcBridgeOptions): void {
    const { client, dshSessionId, rpcHandlerManager, projector, logTag } = options
    const tag = logTag ?? 'dsh'
    const sid = SessionId(dshSessionId)

    rpcHandlerManager.registerHandler(RPC_METHODS.DshAction, async (payload: unknown) => {
        const action = DshActionSchema.parse(payload)
        switch (action.type) {
            case 'prompt': {
                const result = await client.prompt({
                    sessionId: dshSessionId,
                    mode: action.mode,
                    content: [{ type: 'text', text: action.text }]
                })
                return { accepted: result.accepted }
            }
            case 'interrupt': {
                await client.cancel(dshSessionId)
                return { accepted: true }
            }
            case 'approval.respond': {
                const rpcId = projector.approvalRpcId(action.approvalId)
                if (!rpcId) {
                    throw new Error(`approval ${action.approvalId} is not pending`)
                }
                await client.respond(rpcId, {
                    sessionId: sid,
                    approvalId: action.approvalId as never,
                    outcome: action.outcome
                })
                return { accepted: true }
            }
            case 'question.respond': {
                await client.respond(action.questionRpcId, {
                    sessionId: sid,
                    answer: action.answer
                })
                return { accepted: true }
            }
            case 'queue.action': {
                await client.updateQueueAction({
                    sessionId: dshSessionId,
                    itemId: action.itemId,
                    action: action.action.kind === 'edit'
                        ? { kind: 'edit', content: [{ type: 'text', text: action.action.text }] }
                        : { kind: action.action.kind }
                })
                return { accepted: true }
            }
            case 'model.select': {
                const result = await client.selectModel({
                    sessionId: dshSessionId,
                    provider: action.provider,
                    model: action.model,
                    ...(action.reasoningEffort !== undefined ? { reasoningEffort: action.reasoningEffort } : {})
                })
                const selected: DshSelectModelResponse = {
                    selected: {
                        provider: result.selected.provider,
                        model: result.selected.model,
                        ...(result.selected.reasoningEffort !== undefined ? { reasoningEffort: result.selected.reasoningEffort } : {})
                    }
                }
                return selected
            }
            case 'goal': {
                const goalResult = await dispatchGoal(client, sid, action)
                return goalResult
            }
            case 'subagent': {
                return await dispatchSubagent(client, sid, action)
            }
            case 'agentPresets': {
                if (action.action === 'select') {
                    if (!action.agentPreset) {
                        throw new Error('agentPresets.select requires agentPreset')
                    }
                    const result = await client.selectAgentPreset(sid, action.agentPreset)
                    return { agentPreset: result.agentPreset }
                }
                const result = await client.listAgentPresets()
                const response: DshAgentPresetsResponse = {
                    presets: result.presets.map((preset) => ({
                        id: preset.id,
                        trust: preset.trust,
                        isDefault: preset.isDefault,
                        ...(preset.name !== undefined ? { name: preset.name } : {}),
                        ...(preset.description !== undefined ? { description: preset.description } : {}),
                        ...(preset.broken !== undefined ? { broken: preset.broken } : {})
                    })),
                    authorable: result.authorable,
                    hasDocument: result.hasDocument
                }
                return response
            }
            case 'nativeHistory': {
                const page = await client.sessionHistory({
                    sessionId: dshSessionId,
                    ...(action.beforeSeq !== undefined ? { beforeSeq: action.beforeSeq } : {}),
                    ...(action.maxMessages !== undefined ? { maxMessages: action.maxMessages } : {})
                })
                const response: DshNativeHistoryResponse = {
                    events: page.events.map((entry) => ({
                        seq: entry.event.seq,
                        type: entry.event.type,
                        time: entry.event.time,
                        data: entry.event.data,
                        dshSessionId,
                        ...('surfaceOp' in entry.event && entry.event.surfaceOp !== undefined ? { surfaceOp: entry.event.surfaceOp as 'append' | { op: 'replace'; start: number; end: number } } : {}),
                        ...('sourceEventSeqs' in entry.event && entry.event.sourceEventSeqs !== undefined ? { sourceEventSeqs: entry.event.sourceEventSeqs } : {})
                    })),
                    hasMore: page.hasMore
                }
                return response
            }
            case 'fork': {
                const result = await client.forkSession({
                    sessionId: dshSessionId,
                    ...(action.atSeq !== undefined ? { atSeq: action.atSeq } : {})
                })
                return { sessionId: result.sessionId }
            }
            case 'feedback': {
                return await dispatchFeedback(client, sid, action)
            }
            default: {
                const exhaustive: never = action
                throw new Error(`unhandled DSH action: ${String((exhaustive as { type?: string }).type)}`)
            }
        }
    })

    rpcHandlerManager.registerHandler(RPC_METHODS.DshModels, async () => {
        const models = await client.sessionModels(dshSessionId)
        const response: DshModelsResponse = {
            current: {
                provider: models.current.provider,
                model: models.current.model,
                ...(models.current.reasoningEffort !== undefined ? { reasoningEffort: models.current.reasoningEffort } : {})
            },
            routable: models.routable,
            groups: models.groups.map((group) => ({
                id: group.id,
                name: group.name,
                models: group.models.map((model) => ({
                    id: model.id,
                    name: model.name,
                    ...(model.description !== undefined ? { description: model.description } : {}),
                    ...(model.reasoning
                        ? {
                            efforts: model.reasoning.efforts.map((effort) => ({
                                id: effort.id,
                                name: effort.name,
                                ...(effort.description !== undefined ? { description: effort.description } : {})
                            })),
                            ...(model.reasoning.defaultEffort !== undefined ? { defaultEffort: model.reasoning.defaultEffort } : {})
                        }
                        : {})
                }))
            })),
            failures: models.failures.map((failure) => ({
                id: failure.id,
                name: failure.name,
                message: failure.message
            }))
        }
        return response
    })

    rpcHandlerManager.registerHandler(RPC_METHODS.DshSkills, async () => {
        const result = await client.listSkills(sid)
        const response: DshSkillsResponse = {
            skills: result.skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
                modelInvocable: skill.modelInvocable
            }))
        }
        return response
    })

    logger.debug(`[${tag}] DSH RPC handlers registered`)
}

async function dispatchGoal(
    client: DshClient,
    sid: ReturnType<typeof SessionId>,
    action: Extract<import('@hapi/protocol').DshAction, { type: 'goal' }>
): Promise<DshGoalResponse> {
    const ref = action.refId !== undefined && action.revision !== undefined
        ? { id: action.refId as never, revision: action.revision } as { id: string; revision: number }
        : undefined
    type GoalResult = { ref?: { id: string; revision: number } }
    const asRef = (result: GoalResult): DshGoalResponse => {
        if (!result.ref) return {}
        return { refId: String(result.ref.id), revision: result.ref.revision }
    }
    switch (action.action) {
        case 'create': {
            const result = await client.goals.create({ sessionId: sid, objective: action.objective!, ...(action.maxGoalRounds !== undefined ? { maxGoalRounds: action.maxGoalRounds } : {}) }) as GoalResult
            return asRef(result)
        }
        case 'edit': {
            if (!ref) throw new Error('goal.edit requires refId + revision')
            const result = await client.goals.edit({
                sessionId: sid,
                ref,
                ...(action.objective !== undefined ? { objective: action.objective } : {}),
                ...(action.maxGoalRounds !== undefined ? { maxGoalRounds: action.maxGoalRounds } : {})
            }) as GoalResult
            return asRef(result)
        }
        case 'pause':
        case 'resume':
        case 'complete': {
            if (!ref) throw new Error(`goal.${action.action} requires refId + revision`)
            const result = await client.goals[action.action]({ sessionId: sid, ref }) as GoalResult
            return asRef(result)
        }
        case 'clear': {
            if (!ref) throw new Error('goal.clear requires refId + revision')
            await client.goals.clear({ sessionId: sid, ref })
            return {}
        }
    }
}

async function dispatchSubagent(
    client: DshClient,
    sid: ReturnType<typeof SessionId>,
    action: Extract<import('@hapi/protocol').DshAction, { type: 'subagent' }>
): Promise<unknown> {
    switch (action.action) {
        case 'list': {
            const result = await client.subagents.list({ parentSessionId: sid }) as {
                parentAvailable: boolean
                entries: Array<{
                    kind: 'child' | 'diagnostic'
                    id: string
                    mode?: 'one-shot' | 'continuable'
                    label?: string
                    activity?: 'running' | 'inactive'
                    hasChildren?: boolean
                    reason?: 'corrupt' | 'unsupported' | 'unavailable'
                }>
            }
            const catalog: DshSubagentCatalog = {
                parentAvailable: result.parentAvailable,
                entries: result.entries.map((entry) => {
                    if (entry.kind === 'diagnostic') {
                        return { id: entry.id, kind: 'diagnostic', reason: entry.reason ?? 'unavailable' }
                    }
                    return {
                        id: entry.id,
                        kind: 'child',
                        mode: entry.mode ?? 'continuable',
                        ...(entry.label !== undefined ? { label: entry.label } : {}),
                        ...(entry.activity !== undefined ? { activity: entry.activity } : {}),
                        ...(entry.hasChildren ? { hasChildren: true } : {})
                    }
                })
            }
            return catalog
        }
        case 'history': {
            if (!action.childSessionId) throw new Error('subagent.history requires childSessionId')
            const page = await client.subagents.history({
                parentSessionId: sid,
                childSessionId: action.childSessionId,
                mode: action.mode ?? 'continuable',
                ...(action.beforeSeq !== undefined ? { beforeSeq: action.beforeSeq } : {}),
                ...(action.maxMessages !== undefined ? { maxMessages: action.maxMessages } : {})
            }) as { events: Array<{ event: { seq: number; type: string; time: number; data: unknown; surfaceOp?: unknown; sourceEventSeqs?: number[] } }>; hasMore: boolean }
            const response: DshNativeHistoryResponse = {
                events: page.events.map((entry) => ({
                    seq: entry.event.seq,
                    type: entry.event.type,
                    time: entry.event.time,
                    data: entry.event.data,
                    dshSessionId: action.childSessionId!,
                    ...('surfaceOp' in entry.event && entry.event.surfaceOp !== undefined ? { surfaceOp: entry.event.surfaceOp as 'append' | { op: 'replace'; start: number; end: number } } : {}),
                    ...('sourceEventSeqs' in entry.event && entry.event.sourceEventSeqs !== undefined ? { sourceEventSeqs: entry.event.sourceEventSeqs } : {})
                })),
                hasMore: page.hasMore
            }
            return response
        }
        case 'prompt': {
            if (!action.childSessionId || !action.text) throw new Error('subagent.prompt requires childSessionId + text')
            const result = await client.subagents.prompt({
                parentSessionId: sid,
                childSessionId: action.childSessionId,
                mode: action.mode ?? 'continuable',
                content: [{ type: 'text', text: action.text }]
            }) as { messageId: string }
            return { messageId: result.messageId }
        }
        case 'interrupt': {
            if (!action.childSessionId) throw new Error('subagent.interrupt requires childSessionId')
            await client.subagents.interrupt({
                parentSessionId: sid,
                childSessionId: action.childSessionId,
                mode: action.mode ?? 'continuable'
            })
            return { accepted: true }
        }
    }
}

async function dispatchFeedback(
    client: DshClient,
    sid: ReturnType<typeof SessionId>,
    action: Extract<import('@hapi/protocol').DshAction, { type: 'feedback' }>
): Promise<DshFeedbackResponse> {
    switch (action.action) {
        case 'list': {
            const result = await client.gatewayCall<{ items: Array<{ messageId: string; rating?: string; note?: string; version: string }> }>(
                'messageFeedback/list',
                { sessionId: sid }
            )
            return {
                items: result.items.map((item) => ({
                    messageId: item.messageId,
                    ...(item.rating !== undefined ? { rating: item.rating as 'positive' | 'negative' } : {}),
                    ...(item.note !== undefined ? { note: item.note } : {}),
                    version: item.version
                }))
            }
        }
        case 'put': {
            if (!action.messageId || !action.rating) throw new Error('feedback.put requires messageId + rating')
            await client.gatewayCall('messageFeedback/put', {
                sessionId: sid,
                messageId: action.messageId as never,
                rating: action.rating,
                ...(action.note !== undefined ? { note: action.note } : {}),
                ifVersion: action.ifVersion ?? null
            })
            return { items: [] }
        }
        case 'delete': {
            if (!action.messageId) throw new Error('feedback.delete requires messageId')
            await client.gatewayCall('messageFeedback/delete', {
                sessionId: sid,
                messageId: action.messageId as never,
                ifVersion: action.ifVersion ?? null
            })
            return { items: [] }
        }
    }
}
