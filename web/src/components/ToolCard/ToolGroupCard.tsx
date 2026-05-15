import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { ToolDetailDialogContent, ToolStatusIcon, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { formatGroupedHeaderSubtitle, formatGroupedHeaderTitle, formatGroupedRowLabel } from '@/components/ToolCard/groupedPresentation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function DetailsIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function SummaryBadge(props: { className: string; text: string }) {
    return (
        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', props.className)}>
            {props.text}
        </span>
    )
}

function RowStatusBadge(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    if (props.block.tool.state === 'error') {
        return <SummaryBadge className="bg-red-500/10 text-red-600" text={t('toolGroup.rowStatus.error')} />
    }
    if (props.block.tool.state === 'running') {
        return <SummaryBadge className="bg-sky-500/10 text-sky-600" text={t('toolGroup.rowStatus.running')} />
    }
    if (props.block.tool.state === 'pending') {
        return <SummaryBadge className="bg-amber-500/10 text-amber-700" text={t('toolGroup.rowStatus.pending')} />
    }
    return null
}

function formatActionSummary(block: ToolGroupBlock, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const parts: string[] = []
    const { countsByKind } = block.summary

    if (countsByKind.mutation > 0) {
        parts.push(t('toolGroup.summary.mutation', { n: countsByKind.mutation }))
    }
    if (countsByKind.read > 0) {
        parts.push(t('toolGroup.summary.read', { n: countsByKind.read }))
    }
    if (countsByKind.command > 0) {
        parts.push(t('toolGroup.summary.command', { n: countsByKind.command }))
    }
    if (countsByKind.search > 0) {
        parts.push(t('toolGroup.summary.search', { n: countsByKind.search }))
    }
    if (countsByKind.web > 0) {
        parts.push(t('toolGroup.summary.web', { n: countsByKind.web }))
    }
    if (countsByKind.other > 0) {
        parts.push(t('toolGroup.summary.other', { n: countsByKind.other }))
    }

    return parts.length > 0 ? parts.join(' · ') : null
}

function RowLabel(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }, t), [props.block, props.metadata, t])

    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                    {presentation.icon}
                </div>
                <div className="min-w-0 truncate whitespace-nowrap text-sm font-medium text-[var(--app-fg)]">
                    {formatGroupedRowLabel(props.block, t)}
                </div>
            </div>
        </div>
    )
}

export function ToolGroupCard(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [open, setOpen] = useState(props.block.defaultOpen)
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const [isHydratingHistory, setIsHydratingHistory] = useState(false)
    const [historyExhausted, setHistoryExhausted] = useState(false)
    const [retryNonce, setRetryNonce] = useState(0)
    const hydrationRunRef = useRef(0)
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    function clearRetryTimer() {
        if (retryTimerRef.current === null) {
            return
        }
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
    }

    useEffect(() => {
        clearRetryTimer()
        hydrationRunRef.current += 1
        setOpen(props.block.defaultOpen)
        setSelectedToolId(null)
        setIsHydratingHistory(false)
        setHistoryExhausted(false)
    }, [props.block.id, props.block.defaultOpen])

    useEffect(() => {
        return () => {
            clearRetryTimer()
        }
    }, [])

    useEffect(() => {
        if (!open) {
            clearRetryTimer()
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(false)
            return
        }
        if (!props.block.needsOlderHistory) {
            clearRetryTimer()
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(false)
            return
        }
        if (isHydratingHistory || historyExhausted) {
            return
        }
        if (ctx.isLoadingMoreMessages) {
            return
        }
        if (!ctx.hasMoreMessages) {
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(true)
            return
        }

        const runId = hydrationRunRef.current + 1
        hydrationRunRef.current = runId
        setHistoryExhausted(false)
        setIsHydratingHistory(true)
        void ctx.loadOlderMessagesPreservingScroll()
            .then((loaded) => {
                if (hydrationRunRef.current !== runId) return
                setIsHydratingHistory(false)
                if (!loaded) {
                    if (!ctx.hasMoreMessages) {
                        setHistoryExhausted(true)
                        return
                    }
                    clearRetryTimer()
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null
                        if (hydrationRunRef.current !== runId) return
                        setRetryNonce((value) => value + 1)
                    }, 150)
                }
            })
            .catch(() => {
                if (hydrationRunRef.current !== runId) return
                clearRetryTimer()
                setIsHydratingHistory(false)
                setHistoryExhausted(true)
            })
    }, [
        open,
        props.block.needsOlderHistory,
        ctx.hasMoreMessages,
        ctx.isLoadingMoreMessages,
        ctx.loadOlderMessagesPreservingScroll,
        historyExhausted,
        isHydratingHistory,
        retryNonce,
    ])

    const selectedTool = useMemo(
        () => props.block.tools.find((tool) => tool.id === selectedToolId) ?? null,
        [props.block.tools, selectedToolId]
    )
    const selectedPresentation = useMemo(() => {
        if (!selectedTool) return null
        return getToolPresentation({
            toolName: selectedTool.tool.name,
            input: selectedTool.tool.input,
            result: selectedTool.tool.result,
            childrenCount: selectedTool.children.length,
            description: selectedTool.tool.description,
            metadata: props.metadata
        }, t)
    }, [selectedTool, props.metadata, t])

    const primaryTitle = formatGroupedHeaderTitle(props.block, t)
    const subtitle = formatGroupedHeaderSubtitle(props.block, t) ?? formatActionSummary(props.block, t)
    const fileCount = props.block.summary.fileTargets.length

    return (
        <Card className="overflow-hidden rounded-[20px] bg-[var(--app-tool-group-bg)] shadow-none">
            <CardHeader className={cn('space-y-0 p-3', subtitle ? 'pb-2' : null)}>
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-expanded={open}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex flex-1 flex-col gap-1">
                            <div className="min-w-0 flex items-center gap-2">
                                <div className="shrink-0 flex h-3.5 w-3.5 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                                    <DetailsIcon />
                                </div>
                                <CardTitle className="min-w-0 truncate whitespace-nowrap text-sm font-medium leading-tight text-[var(--app-fg)]">
                                    {primaryTitle}
                                </CardTitle>
                            </div>
                            {subtitle ? (
                                <CardDescription className="truncate whitespace-nowrap font-mono text-xs text-[var(--app-tool-card-subtitle)]">
                                    {subtitle}
                                </CardDescription>
                            ) : null}
                        </div>

                        <div className="flex shrink-0 items-center gap-2 self-center text-[var(--app-hint)]">
                            {props.block.summary.runningCount > 0 ? (
                                <SummaryBadge
                                    className="bg-sky-500/10 text-sky-600"
                                    text={t('toolGroup.badge.running', { n: props.block.summary.runningCount })}
                                />
                            ) : null}
                            {props.block.summary.pendingCount > 0 ? (
                                <SummaryBadge
                                    className="bg-amber-500/10 text-amber-700"
                                    text={t('toolGroup.badge.pending', { n: props.block.summary.pendingCount })}
                                />
                            ) : null}
                            {props.block.summary.errorCount > 0 ? (
                                <SummaryBadge
                                    className="bg-red-500/10 text-red-600"
                                    text={t('toolGroup.badge.error', { n: props.block.summary.errorCount })}
                                />
                            ) : null}
                            {fileCount > 0 ? (
                                <SummaryBadge
                                    className="bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                                    text={t('toolGroup.badge.fileTargets', { n: fileCount })}
                                />
                            ) : null}
                        </div>
                    </div>
                </button>
            </CardHeader>

            {open ? (
                <CardContent className="px-3 pb-3 pt-1">
                    <div className="mb-3 text-xs text-[var(--app-hint)]">
                        {t('toolGroup.toolCount', { n: props.block.tools.length })}
                    </div>

                    <div className="flex flex-col gap-2">
                        {props.block.tools.map((tool) => {
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    className="flex items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    onClick={() => setSelectedToolId(tool.id)}
                                >
                                    <span className={cn('shrink-0', toolStatusColorClass(tool.tool.state))}>
                                        <ToolStatusIcon state={tool.tool.state} />
                                    </span>
                                    <RowLabel block={tool} metadata={props.metadata} />
                                    <div className="flex shrink-0 items-center gap-2">
                                        <RowStatusBadge block={tool} />
                                    </div>
                                </button>
                            )
                        })}
                    </div>

                    {isHydratingHistory ? (
                        <div className="mt-3 text-xs text-[var(--app-hint)]">
                            {t('toolGroup.loadingOlderHistory')}
                        </div>
                    ) : null}
                    {!isHydratingHistory && historyExhausted && props.block.needsOlderHistory ? (
                        <div className="mt-3 text-xs text-[var(--app-hint)]">
                            {t('toolGroup.historyUnavailable')}
                        </div>
                    ) : null}
                </CardContent>
            ) : null}

            <Dialog open={selectedTool !== null} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setSelectedToolId(null)
                }
            }}>
                <DialogContent className="max-w-2xl" aria-describedby={undefined}>
                    {selectedTool && selectedPresentation ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{selectedPresentation.title}</DialogTitle>
                            </DialogHeader>
                            <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Card>
    )
}
