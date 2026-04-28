import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ChatBlock, CodexSubagentBlock, CodexSubagentOutputEvent } from '@/chat/types'
import type { ToolCallBlock } from '@/chat/types'
import { isObject, safeStringify } from '@hapi/protocol'
import { getEventPresentation } from '@/chat/presentation'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { CliOutputBlock } from '@/components/CliOutputBlock'

function isToolCallBlock(value: unknown): value is ToolCallBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'tool-call') return false
    if (typeof value.id !== 'string') return false
    if (value.localId !== null && typeof value.localId !== 'string') return false
    if (typeof value.createdAt !== 'number') return false
    if (!Array.isArray(value.children)) return false
    if (!isObject(value.tool)) return false
    if (typeof value.tool.name !== 'string') return false
    if (!('input' in value.tool)) return false
    if (value.tool.description !== null && typeof value.tool.description !== 'string') return false
    if (value.tool.state !== 'pending' && value.tool.state !== 'running' && value.tool.state !== 'completed' && value.tool.state !== 'error') return false
    return true
}

function isCodexSubagentBlock(value: unknown): value is CodexSubagentBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'codex-subagents') return false
    if (typeof value.id !== 'string') return false
    if (typeof value.createdAt !== 'number') return false
    if (!isObject(value.action)) return false
    if (!isObject(value.outputsByThreadId)) return false
    return true
}

function getSubagentLabel(block: CodexSubagentBlock, threadId: string): string {
    const agent = block.action.agents.find((candidate) => candidate.threadId === threadId)
    if (!agent) return threadId.length > 14 ? `Agent ${threadId.slice(-8)}` : threadId
    if (agent.nickname && agent.role) return `${agent.nickname} [${agent.role}]`
    return agent.nickname ?? agent.role ?? (threadId.length > 14 ? `Agent ${threadId.slice(-8)}` : threadId)
}

function subagentSummary(block: CodexSubagentBlock): string {
    const count = Math.max(1, block.action.receiverThreadIds.length, block.action.agents.length)
    const noun = count === 1 ? 'agent' : 'agents'
    const tool = block.action.tool.toLowerCase().replace(/[\s_-]/g, '')
    if (tool === 'spawnagent') return `Spawning ${count} ${noun}`
    if (tool === 'waitagent' || tool === 'wait') return `Waiting on ${count} ${noun}`
    if (tool === 'sendinput') return count === 1 ? 'Updating agent' : 'Updating agents'
    if (tool === 'closeagent') return `Closing ${count} ${noun}`
    if (tool === 'resumeagent') return `Resuming ${count} ${noun}`
    return count === 1 ? 'Agent activity' : `Agent activity (${count})`
}

function outputPrefix(output: CodexSubagentOutputEvent): string {
    if (output.role === 'assistant') return 'Assistant'
    if (output.role === 'reasoning') return 'Thinking'
    if (output.role === 'tool') return 'Tool'
    if (output.role === 'result') return 'Result'
    return 'Status'
}

function CodexSubagentCard(props: { block: CodexSubagentBlock }) {
    const block = props.block
    const threadIds = Array.from(new Set([
        ...block.action.receiverThreadIds,
        ...block.action.agents.map((agent) => agent.threadId),
        ...Object.keys(block.outputsByThreadId)
    ]))

    return (
        <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                <details>
                    <summary className="cursor-pointer list-none p-3">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <span aria-hidden="true">🧩</span>
                                    <span>Subagents</span>
                                </div>
                                <div className="mt-1 font-mono text-xs text-[var(--app-hint)]">
                                    {subagentSummary(block)}
                                </div>
                            </div>
                            <span className="text-xs text-[var(--app-hint)]">Details</span>
                        </div>
                    </summary>
                    <div className="border-t border-[var(--app-border)] px-3 pb-3">
                        <div className="mt-3 flex flex-col gap-3">
                            {threadIds.map((threadId) => {
                                const outputs = block.outputsByThreadId[threadId] ?? []
                                const agent = block.action.agents.find((candidate) => candidate.threadId === threadId)
                                return (
                                    <div key={threadId} className="rounded-md bg-[var(--app-secondary-bg)] p-2">
                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                            <span className="font-medium">{getSubagentLabel(block, threadId)}</span>
                                            {agent?.model ? <span className="font-mono text-[var(--app-hint)]">{agent.model}</span> : null}
                                            {agent?.status ? <span className="text-[var(--app-hint)]">{agent.status}</span> : null}
                                        </div>
                                        {outputs.length > 0 ? (
                                            <div className="mt-2 flex flex-col gap-2">
                                                {outputs.map((output, index) => (
                                                    <div key={`${threadId}:${index}`} className="text-xs">
                                                        <span className="font-mono text-[var(--app-hint)]">{outputPrefix(output)}: </span>
                                                        <span className="whitespace-pre-wrap break-words">{output.text}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="mt-2 text-xs text-[var(--app-hint)]">No output yet</div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </details>
            </div>
        </div>
    )
}

function isPendingPermissionBlock(block: ChatBlock): boolean {
    return block.kind === 'tool-call' && block.tool.permission?.status === 'pending'
}

function splitTaskChildren(block: ToolCallBlock): { pending: ChatBlock[]; rest: ChatBlock[] } {
    const pending: ChatBlock[] = []
    const rest: ChatBlock[] = []

    for (const child of block.children) {
        if (isPendingPermissionBlock(child)) {
            pending.push(child)
        } else {
            rest.push(child)
        }
    }

    return { pending, rest }
}

function HappyNestedBlockList(props: {
    blocks: ChatBlock[]
}) {
    const ctx = useHappyChatContext()

    return (
        <div className="flex flex-col gap-3">
            {props.blocks.map((block) => {
                if (block.kind === 'user-text') {
                    const userBubbleClass = 'w-fit max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'
                    const status = block.status
                    const canRetry = status === 'failed' && typeof block.localId === 'string' && Boolean(ctx.onRetryMessage)
                    const onRetry = canRetry ? () => ctx.onRetryMessage!(block.localId!) : undefined

                    return (
                        <div key={`user:${block.id}`} className={userBubbleClass}>
                            <div className="flex items-end gap-2">
                                <div className="flex-1">
                                    <LazyRainbowText text={block.text} />
                                </div>
                                {status ? (
                                    <div className="shrink-0 self-end pb-0.5">
                                        <MessageStatusIndicator status={status} onRetry={onRetry} />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'agent-text') {
                    return (
                        <div key={`agent:${block.id}`} className="px-1">
                            <MarkdownRenderer content={block.text} />
                        </div>
                    )
                }

                if (block.kind === 'cli-output') {
                    const alignClass = block.source === 'user' ? 'ml-auto w-full max-w-[92%]' : ''
                    return (
                        <div key={`cli:${block.id}`} className="px-1 min-w-0 max-w-full overflow-x-hidden">
                            <div className={alignClass}>
                                <CliOutputBlock text={block.text} />
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'agent-event') {
                    const presentation = getEventPresentation(block.event)
                    return (
                        <div key={`event:${block.id}`} className="py-1">
                            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                                <span className="inline-flex items-center gap-1">
                                    {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
                                    <span>{presentation.text}</span>
                                </span>
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'tool-call') {
                    const isTask = block.tool.name === 'Task'
                    const taskChildren = isTask ? splitTaskChildren(block) : null

                    return (
                        <div key={`tool:${block.id}`} className="py-1">
                            <ToolCard
                                api={ctx.api}
                                sessionId={ctx.sessionId}
                                metadata={ctx.metadata}
                                disabled={ctx.disabled}
                                onDone={ctx.onRefresh}
                                block={block}
                            />
                            {block.children.length > 0 ? (
                                isTask ? (
                                    <>
                                        {taskChildren && taskChildren.pending.length > 0 ? (
                                            <div className="mt-2 pl-3">
                                                <HappyNestedBlockList blocks={taskChildren.pending} />
                                            </div>
                                        ) : null}
                                        {taskChildren && taskChildren.rest.length > 0 ? (
                                            <details className="mt-2">
                                                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                                    Task details ({taskChildren.rest.length})
                                                </summary>
                                                <div className="mt-2 pl-3">
                                                    <HappyNestedBlockList blocks={taskChildren.rest} />
                                                </div>
                                            </details>
                                        ) : null}
                                    </>
                                ) : (
                                    <div className="mt-2 pl-3">
                                        <HappyNestedBlockList blocks={block.children} />
                                    </div>
                                )
                            ) : null}
                        </div>
                    )
                }

                if (block.kind === 'codex-subagents') {
                    return <CodexSubagentCard key={`subagents:${block.id}`} block={block} />
                }

                return null
            })}
        </div>
    )
}

export function HappyToolMessage(props: ToolCallMessagePartProps) {
    const ctx = useHappyChatContext()
    const artifact = props.artifact

    if (isCodexSubagentBlock(artifact)) {
        return <CodexSubagentCard block={artifact} />
    }

    if (!isToolCallBlock(artifact)) {
        const argsText = typeof props.argsText === 'string' ? props.argsText.trim() : ''
        const hasArgsText = argsText.length > 0
        const hasResult = props.result !== undefined
        const resultText = hasResult ? safeStringify(props.result) : ''

        return (
            <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
                <div className="rounded-xl bg-[var(--app-secondary-bg)] p-3 shadow-sm">
                    <div className="flex items-center gap-2 text-xs">
                        <div className="font-mono text-[var(--app-hint)]">
                            Tool: {props.toolName}
                        </div>
                        {props.isError ? (
                            <span className="text-red-500">Error</span>
                        ) : null}
                        {props.status.type === 'running' && !hasResult ? (
                            <span className="text-[var(--app-hint)]">Running…</span>
                        ) : null}
                    </div>

                    {hasArgsText ? (
                        <div className="mt-2">
                            <CodeBlock code={argsText} language="json" />
                        </div>
                    ) : null}

                    {hasResult ? (
                        <div className="mt-2">
                            <CodeBlock code={resultText} language={typeof props.result === 'string' ? 'text' : 'json'} />
                        </div>
                    ) : null}
                </div>
            </div>
        )
    }

    const block = artifact
    const isTask = block.tool.name === 'Task'
    const taskChildren = isTask ? splitTaskChildren(block) : null

    return (
        <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
            <ToolCard
                api={ctx.api}
                sessionId={ctx.sessionId}
                metadata={ctx.metadata}
                disabled={ctx.disabled}
                onDone={ctx.onRefresh}
                block={block}
            />
            {block.children.length > 0 ? (
                isTask ? (
                    <>
                        {taskChildren && taskChildren.pending.length > 0 ? (
                            <div className="mt-2 pl-3">
                                <HappyNestedBlockList blocks={taskChildren.pending} />
                            </div>
                        ) : null}
                        {taskChildren && taskChildren.rest.length > 0 ? (
                            <details className="mt-2">
                                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                    Task details ({taskChildren.rest.length})
                                </summary>
                                <div className="mt-2 pl-3">
                                    <HappyNestedBlockList blocks={taskChildren.rest} />
                                </div>
                            </details>
                        ) : null}
                    </>
                ) : (
                    <div className="mt-2 pl-3">
                        <HappyNestedBlockList blocks={block.children} />
                    </div>
                )
            ) : null}
        </div>
    )
}
