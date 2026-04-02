import { useMemo, useState, type ReactNode } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { isObject } from '@hapi/protocol'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getEventPresentation } from '@/chat/presentation'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'

function getSpawnSummary(block: ToolCallBlock): {
    title: string
    subtitle: string | null
    detail: string
    prompt: string | null
    promptPreview: string | null
} {
    const input = isObject(block.tool.input) ? block.tool.input : null
    const result = isObject(block.tool.result) ? block.tool.result : null

    const nickname = result && typeof result.nickname === 'string' && result.nickname.length > 0
        ? result.nickname
        : getInputStringAny(input, ['nickname', 'name', 'agent_name'])
    const prompt = getInputStringAny(input, ['message', 'messagePreview', 'prompt', 'description'])

    const subtitle = nickname && nickname.length > 0 ? nickname : null
    const countLabel = `${block.children.length} nested block${block.children.length === 1 ? '' : 's'}`

    return {
        title: 'Subagent conversation',
        subtitle,
        detail: countLabel,
        prompt: prompt ?? null,
        promptPreview: prompt ? truncate(prompt, 72) : null
    }
}

type LifecycleAction = {
    type?: string
    createdAt?: number
    summary?: string
}

type LifecycleSnapshot = {
    status: 'running' | 'waiting' | 'completed' | 'error' | 'closed'
    latestText: string | null
    agentId: string | null
    nickname: string | null
    actions: LifecycleAction[]
}

function isLifecycleStatus(value: unknown): value is LifecycleSnapshot['status'] {
    return value === 'running' || value === 'waiting' || value === 'completed' || value === 'error' || value === 'closed'
}

function getLifecycleCandidate(block: ToolCallBlock): unknown {
    if (isObject(block.lifecycle)) return block.lifecycle
    const meta = block.meta
    if (!isObject(meta)) return null
    if (isObject(meta.codexLifecycle)) return meta.codexLifecycle
    if (isObject(meta.lifecycle)) return meta.lifecycle
    if (isObject(meta.codexAgentLifecycle)) return meta.codexAgentLifecycle
    return meta
}

function getLifecycleSnapshot(block: ToolCallBlock): LifecycleSnapshot {
    const meta = getLifecycleCandidate(block)
    const agentIdFromMeta = isObject(meta) && typeof meta.agentId === 'string' ? meta.agentId : null
    const nicknameFromMeta = isObject(meta) && typeof meta.nickname === 'string' ? meta.nickname : null
    const statusFromMeta = isObject(meta) && isLifecycleStatus(meta.status) ? meta.status : null
    const latestTextFromMeta = isObject(meta) && typeof meta.latestText === 'string'
        ? meta.latestText
        : isObject(meta) && typeof meta.latest === 'string'
            ? meta.latest
            : isObject(meta) && typeof meta.message === 'string'
                ? meta.message
                : null
    const actionsFromMeta = isObject(meta) && Array.isArray(meta.actions) ? meta.actions : []
    const prompt = getInputStringAny(isObject(block.tool.input) ? block.tool.input : null, ['message', 'messagePreview', 'prompt', 'description'])
    const result = isObject(block.tool.result) ? block.tool.result : null
    const agentIdFromResult = result && typeof result.agent_id === 'string' ? result.agent_id : null
    const nicknameFromResult = result && typeof result.nickname === 'string' ? result.nickname : null

    const status: LifecycleSnapshot['status'] = statusFromMeta ?? (
        block.tool.state === 'completed'
            ? 'completed'
            : block.tool.state === 'error'
                ? 'error'
                : block.tool.state === 'pending'
                    ? 'waiting'
                    : 'running'
    )

    const latestText = latestTextFromMeta ?? (prompt ? truncate(prompt, 120) : null)

    return {
        status,
        latestText,
        agentId: agentIdFromMeta ?? agentIdFromResult,
        nickname: nicknameFromMeta ?? nicknameFromResult,
        actions: actionsFromMeta.filter((action): action is LifecycleAction => isObject(action))
    }
}

function getLifecycleStatusLabel(status: LifecycleSnapshot['status']): string {
    if (status === 'waiting') return 'Waiting'
    if (status === 'completed') return 'Completed'
    if (status === 'error') return 'Error'
    if (status === 'closed') return 'Closed'
    return 'Running'
}

function getLifecycleStatusClass(status: LifecycleSnapshot['status']): string {
    if (status === 'completed') return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    if (status === 'error') return 'bg-red-100 text-red-700 border-red-200'
    if (status === 'closed') return 'bg-slate-100 text-slate-700 border-slate-200'
    if (status === 'waiting') return 'bg-amber-100 text-amber-700 border-amber-200'
    return 'bg-blue-100 text-blue-700 border-blue-200'
}

function OpenIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

function normalizePromptForCompare(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function dedupeLeadingPrompt(
    blocks: ToolCallBlock['children'],
    prompt: string | null
): ToolCallBlock['children'] {
    if (!prompt || blocks.length === 0) return blocks
    const [first, ...rest] = blocks
    if (first.kind !== 'user-text') return blocks

    const promptNorm = normalizePromptForCompare(prompt)
    const firstNorm = normalizePromptForCompare(first.text)
    if (!promptNorm || !firstNorm) return blocks

    if (promptNorm === firstNorm || promptNorm.includes(firstNorm) || firstNorm.includes(promptNorm)) {
        return rest
    }

    return blocks
}

function SubagentBlockList(props: { blocks: ToolCallBlock['children'] }) {
    const ctx = useHappyChatContext()

    return (
        <div className="flex flex-col gap-3">
            {props.blocks.map((block) => {
                if (block.kind === 'user-text') {
                    return (
                        <div key={`user:${block.id}`} className="w-fit max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm">
                            <div className="whitespace-pre-wrap break-words">{block.text}</div>
                        </div>
                    )
                }

                if (block.kind === 'agent-text') {
                    return (
                        <div key={`${block.kind}:${block.id}`} className="px-1">
                            <MarkdownRenderer content={block.text} />
                        </div>
                    )
                }

                if (block.kind === 'agent-reasoning') {
                    return (
                        <div key={`${block.kind}:${block.id}`} className="px-1 whitespace-pre-wrap break-words text-[var(--app-hint)]">
                            {block.text}
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
                                <div className="mt-2 pl-3">
                                    <SubagentBlockList blocks={block.children} />
                                </div>
                            ) : null}
                        </div>
                    )
                }

                return null
            })}
        </div>
    )
}

export function CodexSubagentPreviewCard(props: { block: ToolCallBlock }) {
    const summary = getSpawnSummary(props.block)
    const lifecycle = getLifecycleSnapshot(props.block)
    const dialogTitle = summary.subtitle ? `${summary.title} — ${summary.subtitle}` : summary.title
    const actionCount = lifecycle.actions.length
    const [open, setOpen] = useState(false)
    const dialogBlocks = useMemo(
        () => dedupeLeadingPrompt(props.block.children, summary.prompt),
        [props.block.children, summary.prompt]
    )

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <button
                    type="button"
                    className="w-full text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={dialogTitle}
                >
                    <Card className="overflow-hidden border-dashed bg-[var(--app-secondary-bg)]/50 shadow-sm transition-colors hover:border-[var(--app-link)]">
                        <CardHeader className="p-3 pb-2">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <CardTitle className="text-sm font-medium leading-tight">
                                            {summary.title}
                                        </CardTitle>
                                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getLifecycleStatusClass(lifecycle.status)}`}>
                                            {getLifecycleStatusLabel(lifecycle.status)}
                                        </span>
                                    </div>
                                    {summary.subtitle ? (
                                        <CardDescription className="mt-1 text-xs text-[var(--app-hint)] break-words">
                                            {summary.subtitle}
                                        </CardDescription>
                                    ) : null}
                                </div>
                                <div className="shrink-0 text-[var(--app-hint)]">
                                    <OpenIcon />
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="p-3 pt-0">
                            <div className="flex flex-col gap-2">
                                {lifecycle.latestText ? (
                                    <div className="rounded-lg border border-[var(--app-border)]/70 bg-[var(--app-bg)]/80 px-3 py-2 text-sm text-[var(--app-fg)]">
                                        {truncate(lifecycle.latestText, 96)}
                                    </div>
                                ) : summary.promptPreview ? (
                                    <div className="rounded-lg border border-[var(--app-border)]/70 bg-[var(--app-bg)]/80 px-3 py-2 text-sm text-[var(--app-hint)]">
                                        {summary.promptPreview}
                                    </div>
                                ) : null}
                                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-hint)] break-words">
                                    <span>View transcript</span>
                                    <span>·</span>
                                    <span>{summary.detail}</span>
                                    {actionCount > 0 ? (
                                        <>
                                            <span>·</span>
                                            <span>{actionCount} action{actionCount === 1 ? '' : 's'}</span>
                                        </>
                                    ) : null}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl">
                <DialogClose
                    className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/95 text-[var(--app-hint)] shadow-sm transition-colors hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label="Close dialog"
                >
                    <CloseIcon />
                </DialogClose>
                <DialogHeader className="pr-12">
                        <DialogTitle>{dialogTitle}</DialogTitle>
                        <DialogDescription>
                            Nested child transcript for this Codex subagent run.
                        </DialogDescription>
                </DialogHeader>
                <div className="mt-3 max-h-[75vh] overflow-auto">
                    <div className="flex flex-col gap-3 pr-1">
                        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getLifecycleStatusClass(lifecycle.status)}`}>
                                    {getLifecycleStatusLabel(lifecycle.status)}
                                </span>
                                {actionCount > 0 ? <span className="font-mono text-xs text-[var(--app-hint)]">{actionCount} actions</span> : null}
                            </div>
                            {lifecycle.latestText ? (
                                <div className="mt-2 whitespace-pre-wrap break-words text-sm">
                                    {lifecycle.latestText}
                                </div>
                            ) : summary.promptPreview ? (
                                <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--app-hint)]">
                                    {summary.promptPreview}
                                </div>
                            ) : null}
                        </div>
                        <SubagentBlockList blocks={dialogBlocks} />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
