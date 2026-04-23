import type { ChatBlock, CodexAgentLifecycle, CodexAgentLifecycleStatus, ToolCallBlock } from '@/chat/types'
import { isObject } from '@hapi/protocol'
import { getInputStringAny } from '@/lib/toolInputUtils'

const CONTROL_TOOL_NAMES = new Set(['CodexWaitAgent', 'CodexSendInput', 'CodexCloseAgent'])

type LifecycleActionType = 'wait' | 'send' | 'close'

function normalizeLifecycleStatus(value: string): CodexAgentLifecycleStatus | null {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'running' || normalized === 'in_progress' || normalized === 'in progress') return 'running'
    if (normalized === 'waiting' || normalized === 'pending') return 'waiting'
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'finished') return 'completed'
    if (normalized === 'error' || normalized === 'failed' || normalized === 'failure' || normalized === 'errored') return 'error'
    if (normalized === 'closed' || normalized === 'close') return 'closed'
    return null
}

function statusPriority(status: CodexAgentLifecycleStatus): number {
    switch (status) {
        case 'error':
            return 50
        case 'completed':
            return 40
        case 'closed':
            return 30
        case 'waiting':
            return 20
        case 'running':
        default:
            return 10
    }
}

function pickHigherStatus(current: CodexAgentLifecycleStatus, next: CodexAgentLifecycleStatus): CodexAgentLifecycleStatus {
    return statusPriority(next) >= statusPriority(current) ? next : current
}

function extractSpawnIdentity(block: ToolCallBlock): { agentId: string; nickname: string | null } | null {
    const result = isObject(block.tool.result) ? block.tool.result : null
    const agentId = result && typeof result.agent_id === 'string' && result.agent_id.length > 0
        ? result.agent_id
        : null
    if (!agentId) return null

    const nicknameFromResult = result && typeof result.nickname === 'string' && result.nickname.length > 0
        ? result.nickname
        : null
    const nicknameFromInput = getInputStringAny(block.tool.input, ['nickname', 'name', 'agent_name'])

    return {
        agentId,
        nickname: nicknameFromResult ?? nicknameFromInput
    }
}

function ensureLifecycle(block: ToolCallBlock, agentId: string, nickname: string | null): CodexAgentLifecycle {
    if (block.lifecycle) {
        if (nickname && !block.lifecycle.nickname) {
            block.lifecycle = { ...block.lifecycle, nickname }
        }
        return block.lifecycle
    }

    const lifecycle: CodexAgentLifecycle = {
        kind: 'codex-agent-lifecycle',
        agentId,
        nickname: nickname ?? undefined,
        status: 'running',
        actions: [],
        hiddenToolIds: []
    }
    block.lifecycle = lifecycle
    return lifecycle
}

function stringifyTargetList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function parseResultObject(value: unknown): Record<string, unknown> | null {
    if (isObject(value)) return value
    if (typeof value !== 'string') return null

    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return null

    try {
        const parsed = JSON.parse(trimmed)
        return isObject(parsed) ? parsed : null
    } catch {
        return null
    }
}

function extractResolvedWaitTargets(block: ToolCallBlock): string[] | null {
    if (block.tool.name !== 'CodexWaitAgent') {
        return null
    }

    const result = isObject(block.tool.result) ? block.tool.result : null
    if (!result || !isObject(result.statuses)) {
        return null
    }

    const resolvedTargets = Object.keys(result.statuses).filter((target) => target.length > 0)
    return resolvedTargets.length > 0 ? resolvedTargets : null
}

function extractControlTargets(block: ToolCallBlock): string[] {
    const input = isObject(block.tool.input) ? block.tool.input : null
    if (!input) return []

    if (block.tool.name === 'CodexWaitAgent') {
        return stringifyTargetList(input.targets)
    }

    const target = getInputStringAny(input, ['target', 'agent_id', 'agentId'])
    return target ? [target] : []
}

function extractWaitTargetUpdate(raw: unknown): {
    status: CodexAgentLifecycleStatus | null
    rawStatus: string | null
    message: string | null
} {
    if (typeof raw === 'string') {
        return {
            status: normalizeLifecycleStatus(raw),
            rawStatus: raw,
            message: null
        }
    }

    const rawObject = isObject(raw) ? raw : null
    if (!rawObject) {
        return {
            status: null,
            rawStatus: null,
            message: null
        }
    }

    const explicitStatus = getInputStringAny(rawObject, ['status', 'state'])
    const explicitMessage = getInputStringAny(rawObject, ['message', 'text', 'summary', 'output'])
    if (explicitStatus) {
        return {
            status: normalizeLifecycleStatus(explicitStatus),
            rawStatus: explicitStatus,
            message: explicitMessage
        }
    }

    const completedMessage = getInputStringAny(rawObject, ['completed', 'complete', 'done', 'finished'])
    if (completedMessage) {
        return {
            status: 'completed',
            rawStatus: 'completed',
            message: completedMessage
        }
    }

    const errorMessage = getInputStringAny(rawObject, ['error', 'failed', 'failure'])
    if (errorMessage) {
        return {
            status: 'error',
            rawStatus: 'error',
            message: errorMessage
        }
    }

    return {
        status: null,
        rawStatus: null,
        message: explicitMessage
    }
}

function summarizeWaitResult(block: ToolCallBlock, targets: string[]): { status: CodexAgentLifecycleStatus | null; summary: string } {
    const result = block.tool.result
    const resultObject = parseResultObject(result)
    const targetLabel = targets.length > 0 ? targets.join(', ') : 'agent'

    if (!resultObject) {
        return { status: null, summary: `${targetLabel}: ${String(result ?? '')}`.trim() }
    }

    if (typeof resultObject.status === 'string') {
        const status = normalizeLifecycleStatus(resultObject.status)
        return {
            status,
            summary: typeof resultObject.text === 'string' && resultObject.text.trim().length > 0
                ? resultObject.text.trim()
                : `${targetLabel}: ${resultObject.status}`
        }
    }

    const statuses = isObject(resultObject.statuses)
        ? resultObject.statuses
        : isObject(resultObject.status)
            ? resultObject.status
            : null

    if (statuses) {
        const parts: string[] = []
        let status: CodexAgentLifecycleStatus | null = null
        let singleTargetMessage: string | null = null
        for (const target of targets) {
            const update = extractWaitTargetUpdate(statuses[target])
            if (update.status) {
                status = status ? pickHigherStatus(status, update.status) : update.status
            }
            if (targets.length === 1 && update.message) {
                singleTargetMessage = update.message
            }
            if (update.message) {
                parts.push(`${target}: ${update.message}`)
            } else if (update.rawStatus) {
                parts.push(`${target}: ${update.rawStatus}`)
            }
        }
        if (singleTargetMessage) {
            return {
                status,
                summary: singleTargetMessage
            }
        }
        if (parts.length > 0) {
            return {
                status,
                summary: parts.join(' / ')
            }
        }
    }

    if (resultObject.timed_out === true) {
        return {
            status: 'waiting',
            summary: `${targetLabel}: timed out`
        }
    }

    if (typeof resultObject.text === 'string' && resultObject.text.trim().length > 0) {
        return {
            status: null,
            summary: resultObject.text.trim()
        }
    }

    const text = getInputStringAny(resultObject, ['message', 'summary', 'output', 'error'])
    if (text) {
        return { status: null, summary: text }
    }

    return {
        status: null,
        summary: `${targetLabel}: updated`
    }
}

function summarizeSendResult(block: ToolCallBlock, target: string | null): string {
    const result = block.tool.result
    const resultText = getInputStringAny(result, ['message', 'summary', 'output', 'error', 'text'])
    if (resultText) return resultText
    return target ? `Sent input to ${target}` : 'Sent input'
}

function summarizeCloseResult(block: ToolCallBlock, target: string | null): { status: CodexAgentLifecycleStatus | null; summary: string } {
    const result = block.tool.result
    const resultText = getInputStringAny(result, ['message', 'summary', 'output', 'error', 'text'])
    const rawStatus = getInputStringAny(result, ['status'])
    const status = rawStatus ? normalizeLifecycleStatus(rawStatus) : null

    return {
        status: status ?? 'closed',
        summary: resultText ?? (target ? `Closed ${target}` : 'Closed agent')
    }
}

function appendAction(lifecycle: CodexAgentLifecycle, action: LifecycleActionType, createdAt: number, summary: string): void {
    lifecycle.actions.push({ type: action, createdAt, summary })
    lifecycle.latestText = summary
}

function foldControlBlock(block: ToolCallBlock, spawnByAgentId: Map<string, ToolCallBlock>): boolean {
    if (!CONTROL_TOOL_NAMES.has(block.tool.name)) return false

    const targets = extractResolvedWaitTargets(block) ?? extractControlTargets(block)
    const matchedSpawnBlocks = targets
        .map((target) => spawnByAgentId.get(target))
        .filter((spawn): spawn is ToolCallBlock => Boolean(spawn))

    if (matchedSpawnBlocks.length === 0) return false

    const uniqueSpawns = [...new Set(matchedSpawnBlocks)]

    for (const spawn of uniqueSpawns) {
        const spawnIdentity = extractSpawnIdentity(spawn)
        if (!spawnIdentity) continue

        const spawnTargets = targets.filter((target) => spawnByAgentId.get(target) === spawn)
        const scopedTargets = spawnTargets.length > 0 ? spawnTargets : targets
        const lifecycle = ensureLifecycle(spawn, spawnIdentity.agentId, spawnIdentity.nickname)
        lifecycle.hiddenToolIds.push(block.tool.id)

        if (block.tool.name === 'CodexWaitAgent') {
            const result = summarizeWaitResult(block, scopedTargets)
            if (result.status) {
                lifecycle.status = pickHigherStatus(lifecycle.status, result.status)
            } else if (lifecycle.status === 'running') {
                lifecycle.status = 'waiting'
            }
            appendAction(lifecycle, 'wait', block.createdAt, result.summary)
            continue
        }

        if (block.tool.name === 'CodexSendInput') {
            const target = scopedTargets[0] ?? null
            appendAction(lifecycle, 'send', block.createdAt, summarizeSendResult(block, target))
            if (lifecycle.status === 'running') {
                lifecycle.status = 'waiting'
            }
            continue
        }

        if (block.tool.name === 'CodexCloseAgent') {
            const target = scopedTargets[0] ?? null
            const result = summarizeCloseResult(block, target)
            if (result.status) {
                lifecycle.status = pickHigherStatus(lifecycle.status, result.status)
            }
            appendAction(lifecycle, 'close', block.createdAt, result.summary)
        }
    }

    return true
}

export function applyCodexLifecycleAggregation(blocks: ChatBlock[]): ChatBlock[] {
    const spawnByAgentId = new Map<string, ToolCallBlock>()

    for (const block of blocks) {
        if (block.kind !== 'tool-call' || block.tool.name !== 'CodexSpawnAgent') continue
        const identity = extractSpawnIdentity(block)
        if (!identity) continue
        const lifecycle = ensureLifecycle(block, identity.agentId, identity.nickname)
        lifecycle.status = 'running'
        spawnByAgentId.set(identity.agentId, block)
    }

    return blocks.filter((block) => {
        if (block.kind !== 'tool-call') return true
        if (block.tool.name === 'CodexSpawnAgent') return true
        return !foldControlBlock(block, spawnByAgentId)
    })
}
