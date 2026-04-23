import { useMemo, useState } from 'react'
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

function getSubagentSummary(block: ToolCallBlock): {
    title: string
    label: string
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

    const displayName = nickname && nickname.length > 0 ? nickname : 'Subagent conversation'
    const countLabel = `${block.children.length} nested block${block.children.length === 1 ? '' : 's'}`

    return {
        title: displayName,
        label: nickname && nickname.length > 0 ? 'Subagent conversation' : 'Subagent',
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
    if (isObject(meta.subagent)) return meta.subagent
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

const SUBAGENT_ACCENTS = [
    {
        name: 'emerald',
        card: 'border-l-emerald-500 hover:border-l-emerald-600',
        badge: 'border-emerald-300 bg-emerald-100 text-emerald-800'
    },
    {
        name: 'cyan',
        card: 'border-l-cyan-500 hover:border-l-cyan-600',
        badge: 'border-cyan-300 bg-cyan-100 text-cyan-800'
    },
    {
        name: 'amber',
        card: 'border-l-amber-500 hover:border-l-amber-600',
        badge: 'border-amber-300 bg-amber-100 text-amber-800'
    },
    {
        name: 'rose',
        card: 'border-l-rose-500 hover:border-l-rose-600',
        badge: 'border-rose-300 bg-rose-100 text-rose-800'
    },
    {
        name: 'indigo',
        card: 'border-l-indigo-500 hover:border-l-indigo-600',
        badge: 'border-indigo-300 bg-indigo-100 text-indigo-800'
    },
    {
        name: 'lime',
        card: 'border-l-lime-500 hover:border-l-lime-600',
        badge: 'border-lime-300 bg-lime-100 text-lime-800'
    }
] as const

function getSubagentAccent(seed: string | null) {
    const value = seed && seed.length > 0 ? seed : 'subagent'
    let hash = 0
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0
    }
    return SUBAGENT_ACCENTS[hash % SUBAGENT_ACCENTS.length]
}

function getInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean)
    const letters = words.length > 1
        ? `${words[0][0] ?? ''}${words[1][0] ?? ''}`
        : name.trim().slice(0, 2)
    return letters.toUpperCase() || 'SA'
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

export function SubagentPreviewCard(props: { block: ToolCallBlock; dialogDescription?: string }) {
    const summary = getSubagentSummary(props.block)
    const lifecycle = getLifecycleSnapshot(props.block)
    const dialogTitle = `${summary.title} - ${summary.label}`
    const accentSeed = lifecycle.agentId ?? (summary.title !== 'Subagent conversation' ? summary.title : props.block.tool.id)
    const accent = getSubagentAccent(accentSeed)
    const actionCount = lifecycle.actions.length
    const [open, setOpen] = useState(false)
    const dialogBlocks = useMemo(
        () => dedupeLeadingPrompt(props.block.children, summary.prompt),
        [props.block.children, summary.prompt]
    )
    const dialogDescription = props.dialogDescription ?? 'Nested child transcript for this subagent run.'

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <button
                    type="button"
                    className="w-full text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={dialogTitle}
                >
                    <Card
                        data-subagent-accent={accent.name}
                        className={`overflow-hidden border-dashed border-l-4 bg-[var(--app-secondary-bg)]/50 shadow-sm transition-colors hover:border-[var(--app-link)] ${accent.card}`}
                    >
                        <CardHeader className="p-3 pb-2">
                            <div className="flex items-start gap-3">
                                <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-sm font-semibold tracking-normal ${accent.badge}`} aria-hidden="true">
                                    {getInitials(summary.title)}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <CardTitle className="break-words text-base font-semibold leading-tight tracking-normal">
                                                {summary.title}
                                            </CardTitle>
                                            <CardDescription className="mt-0.5 break-words text-[11px] leading-tight text-[var(--app-hint)]">
                                                {summary.label}
                                            </CardDescription>
                                        </div>
                                        <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getLifecycleStatusClass(lifecycle.status)}`}>
                                            {getLifecycleStatusLabel(lifecycle.status)}
                                        </span>
                                    </div>
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
                                    <span>/</span>
                                    <span>{summary.detail}</span>
                                    {actionCount > 0 ? (
                                        <>
                                            <span>/</span>
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
                        {dialogDescription}
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
                            {summary.prompt ? (
                                <div className="mt-2 whitespace-pre-wrap break-words text-sm">
                                    {summary.prompt}
                                </div>
                            ) : null}
                            {lifecycle.latestText ? (
                                <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--app-hint)]">
                                    {lifecycle.latestText}
                                </div>
                            ) : !summary.prompt && summary.promptPreview ? (
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
