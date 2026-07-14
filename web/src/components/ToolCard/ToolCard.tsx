import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { memo, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { getClaudeModelLabel, isObject, safeStringify } from '@hapi/protocol'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { AskUserQuestionFooter } from '@/components/ToolCard/AskUserQuestionFooter'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getToolFullViewComponent, getToolViewComponent } from '@/components/ToolCard/views/_all'
import { getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { formatTaskChildLabel, TaskStateIcon } from '@/components/ToolCard/helpers'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { TraceSection } from '@/components/ToolCard/trace'
import { isSubagentToolName } from '@/chat/subagentTool'

const ELAPSED_INTERVAL_MS = 1000
const TERMINAL_RELATED_TOOL_NAMES = new Set(['Bash', 'CodexBash', 'shell_command', 'run_shell_command'])

export function shouldUseCompactTerminalToolCard(toolName: string, terminalToolDisplayMode: TerminalToolDisplayMode): boolean {
    return TERMINAL_RELATED_TOOL_NAMES.has(toolName) && terminalToolDisplayMode === 'compact'
}

export function shouldShowInlineToolCardBody(
    toolName: string,
    presentationMinimal: boolean,
    terminalToolDisplayMode: TerminalToolDisplayMode
): boolean {
    if (isSubagentToolName(toolName)) return false
    if (TERMINAL_RELATED_TOOL_NAMES.has(toolName)) {
        return terminalToolDisplayMode === 'detailed'
    }
    return !presentationMinimal
}

function ElapsedView(props: { from: number; active: boolean }) {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!props.active) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), ELAPSED_INTERVAL_MS)
        return () => clearInterval(id)
    }, [props.active, props.from])

    if (!props.active) return null

    const elapsed = Math.max(0, now - props.from) / 1000
    if (!Number.isFinite(elapsed)) return null

    return (
        <span className="font-mono text-xs text-[var(--app-hint)]">
            {elapsed.toFixed(1)}s
        </span>
    )
}

// Matches the full SDK model ids Claude Code echoes back for subagents
// (e.g. `claude-sonnet-4-5-20250929`, `claude-opus-4-8`) — a lowercase name,
// a major/minor version, and an optional 8-digit date suffix to discard.
const CLAUDE_SDK_MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/

/**
 * Formats a raw model id for compact display in the subagent badge.
 *
 * Reuses this repo's existing "friendly label, else raw fallback" idiom
 * (see `getClaudeComposerModelOptions` in claudeModelOptions.ts, which does
 * `getClaudeModelLabel(model) ?? model`): `getClaudeModelLabel` only maps the
 * short preset aliases ('sonnet'/'opus'/'fable'), not the full SDK model ids
 * a subagent's own `model` field actually carries, so this adds a second,
 * narrow fallback that extracts just the name + version from the SDK id
 * shape and drops the date suffix. Anything that matches neither (Gemini,
 * Codex, OpenCode, or any future format) is returned as-is — this
 * deliberately doesn't try to parse formats it doesn't recognize.
 */
export function formatSubagentModelLabel(model: string): string {
    const presetLabel = getClaudeModelLabel(model)
    if (presetLabel) return presetLabel

    const match = model.match(CLAUDE_SDK_MODEL_ID_PATTERN)
    if (match) {
        const [, name, major, minor] = match
        return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${major}.${minor}`
    }

    return model
}

/**
 * Derives the model(s) a subagent (Task/Agent tool call) actually executed
 * under, from its own child blocks — not from the parent `ToolCallBlock.model`,
 * which reflects the *calling* session's model and would misattribute the
 * subagent's model if used directly (see reducerTimeline.ts sidechain handling).
 *
 * Every child block produced by reducing the subagent's sidechain carries the
 * `model` of the assistant message it came from. A subagent run can switch
 * models mid-run (e.g. `--fallback-model` kicking in under overload), so this
 * collects the distinct non-null/non-empty raw values in first-seen order —
 * the same "seenModels" pattern `aggregateResponseGroups`
 * (web/src/lib/assistant-runtime.ts) already uses for top-level multi-turn
 * message metadata, reused here rather than inventing a new convention — then
 * formats each for display and joins them.
 */
export function getSubagentModel(children: ChatBlock[]): string | null {
    const seenModels: string[] = []
    for (const child of children) {
        if ('model' in child && child.model && !seenModels.includes(child.model)) {
            seenModels.push(child.model)
        }
    }
    return seenModels.length > 0 ? seenModels.map(formatSubagentModelLabel).join(', ') : null
}

function getTaskSummaryChildren(block: ToolCallBlock): { visible: ToolCallBlock[]; remaining: number } | null {
    if (!isSubagentToolName(block.tool.name)) return null

    const children = block.children
        .filter((child): child is ToolCallBlock => child.kind === 'tool-call')
        .filter((child) => child.tool.state === 'pending' || child.tool.state === 'running' || child.tool.state === 'completed' || child.tool.state === 'error')

    if (children.length === 0) return null

    const visible = children.slice(-3)
    return { visible, remaining: children.length - visible.length }
}

function renderTaskSummary(
    block: ToolCallBlock,
    metadata: SessionMetadataSummary | null,
    t: (key: string, params?: Record<string, string | number>) => string,
): ReactNode | null {
    const summary = getTaskSummaryChildren(block)
    if (!summary) return null

    const visible = summary.visible
    const remaining = summary.remaining

    return (
        <div className="flex flex-col gap-1 px-1">
            <div className="flex flex-col gap-1">
                {visible.map((child) => (
                    <div key={child.id} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 font-mono text-xs text-[var(--app-hint)]">
                            <span className="mr-2 inline-block w-4 text-center align-middle">
                                <TaskStateIcon state={child.tool.state} />
                            </span>
                            <span className="align-middle break-all">
                                {formatTaskChildLabel(child, metadata, t)}
                            </span>
                        </div>
                    </div>
                ))}
                {remaining > 0 ? (
                    <div className="text-xs text-[var(--app-hint)] italic">
                        (+{remaining} more)
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function renderToolInput(block: ToolCallBlock, surface: 'inline' | 'dialog' = 'inline'): ReactNode {
    const collapseLongContent = surface === 'inline'
    const codeBlockSurfaceProps = surface === 'dialog'
        ? { size: 'comfortable' as const, scrollY: true }
        : {}
    const toolName = block.tool.name
    const input = block.tool.input

    if (isSubagentToolName(toolName) && isObject(input) && typeof input.prompt === 'string') {
        return <MarkdownRenderer content={input.prompt} />
    }

    const commandArray = isObject(input) && Array.isArray(input.command) ? input.command : null
    if ((toolName === 'CodexBash' || toolName === 'Bash') && (typeof commandArray?.[0] === 'string' || typeof input === 'object')) {
        const cmd = Array.isArray(commandArray)
            ? commandArray.filter((part) => typeof part === 'string').join(' ')
            : getInputStringAny(input, ['command', 'cmd'])
        if (cmd) {
            return <CodeBlock code={cmd} language="bash" title="Command" collapseLongContent={collapseLongContent} {...codeBlockSurfaceProps} />
        }
    }

    return <CodeBlock code={safeStringify(input)} language="json" title="Input" collapseLongContent={collapseLongContent} {...codeBlockSurfaceProps} />
}

export function ToolStatusIcon(props: { state: ToolCallBlock['tool']['state'] }) {
    if (props.state === 'completed') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.2 8.3l1.8 1.8 3.8-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        )
    }
    if (props.state === 'error') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    }
    if (props.state === 'pending') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <rect x="4.5" y="7" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6 7V5.8a2 2 0 0 1 4 0V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    }
    return (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.75" />
        </svg>
    )
}

export function toolStatusColorClass(state: ToolCallBlock['tool']['state']): string {
    if (state === 'completed') return 'text-emerald-600'
    if (state === 'error') return 'text-red-600'
    if (state === 'pending') return 'text-amber-600'
    return 'text-[var(--app-hint)]'
}

function DetailsIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

const INLINE_PREVIEW_INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, summary, [role="button"], [contenteditable="true"]'

function isNestedInteractiveElement(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): boolean {
    if (event.target === event.currentTarget) return false
    if (!(event.target instanceof Element)) return false

    const interactive = event.target.closest(INLINE_PREVIEW_INTERACTIVE_SELECTOR)
    return interactive !== null && interactive !== event.currentTarget
}

type ToolCardProps = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    disabled: boolean
    onDone: () => void
    block: ToolCallBlock
}

export function ToolDetailDialogContent(props: {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const toolName = props.block.tool.name
    const FullToolView = getToolFullViewComponent(toolName)
    const ResultToolView = getToolResultViewComponent(toolName)
    const permission = props.block.tool.permission
    const isAskUserQuestion = isAskUserQuestionToolName(toolName)
    const isRequestUserInput = isRequestUserInputToolName(toolName)
    const isQuestionTool = isAskUserQuestion || isRequestUserInput
    const isQuestionToolWithAnswers = isQuestionTool
        && permission?.answers
        && Object.keys(permission.answers).length > 0

    return (
        <div className="mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto">
            <div>
                <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">
                    {isQuestionToolWithAnswers ? t('tool.questionsAnswers') : t('tool.input')}
                </div>
                {FullToolView ? (
                    <FullToolView block={props.block} metadata={props.metadata} surface="dialog" />
                ) : (
                    renderToolInput(props.block, 'dialog')
                )}
            </div>
            <TraceSection block={props.block} metadata={props.metadata} />
            {!isQuestionToolWithAnswers ? (
                <div>
                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</div>
                    <ResultToolView block={props.block} metadata={props.metadata} surface="dialog" />
                </div>
            ) : null}
        </div>
    )
}

function ToolCardInner(props: ToolCardProps) {
    const { t } = useTranslation()
    const [detailsOpen, setDetailsOpen] = useState(false)
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }, t), [
        props.block.tool.name,
        props.block.tool.input,
        props.block.tool.result,
        props.block.children.length,
        props.block.tool.description,
        props.metadata,
        t
    ])

    const toolName = props.block.tool.name
    const toolTitle = presentation.title
    const subtitle = presentation.subtitle ?? props.block.tool.description
    const taskSummary = renderTaskSummary(props.block, props.metadata, t)
    const subagentModel = isSubagentToolName(toolName) ? getSubagentModel(props.block.children) : null
    const runningFrom = props.block.tool.startedAt ?? props.block.tool.createdAt
    const isCodexAgentCard = toolName === 'CodexAgent'
    const useCompactTerminalCard = shouldUseCompactTerminalToolCard(toolName, props.terminalToolDisplayMode)
    const showInline = shouldShowInlineToolCardBody(toolName, presentation.minimal, props.terminalToolDisplayMode)
    const CompactToolView = showInline ? getToolViewComponent(toolName) : null
    const ResultToolView = getToolResultViewComponent(toolName)
    const permission = props.block.tool.permission
    const isAskUserQuestion = isAskUserQuestionToolName(toolName)
    const isRequestUserInput = isRequestUserInputToolName(toolName)
    const isQuestionTool = isAskUserQuestion || isRequestUserInput
    const showsPermissionFooter = Boolean(permission && (
        permission.status === 'pending'
        || ((permission.status === 'denied' || permission.status === 'canceled') && Boolean(permission.reason))
    ))
    const hasBody = showInline || taskSummary !== null || showsPermissionFooter
    const stateColor = toolStatusColorClass(props.block.tool.state)
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()
    const openDetails = () => setDetailsOpen(true)
    const openDetailsFromInlinePreview = (event: MouseEvent<HTMLElement>) => {
        if (isNestedInteractiveElement(event)) return
        openDetails()
    }
    const openDetailsFromInlinePreviewKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (isNestedInteractiveElement(event)) return
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openDetails()
        }
    }

    const header = (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex flex-1 flex-col gap-1">
                <div className="min-w-0 flex items-center gap-2">
                    <div className="shrink-0 flex h-3.5 w-3.5 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                        {presentation.icon}
                    </div>
                    <CardTitle className={cn(
                        'min-w-0 text-sm font-medium leading-tight text-[var(--app-fg)]',
                        isCodexAgentCard ? 'truncate whitespace-nowrap' : 'break-words'
                    )}>
                        {toolTitle}
                    </CardTitle>
                </div>

                {subtitle ? (
                    <CardDescription className={cn(
                        'font-mono text-xs text-[var(--app-tool-card-subtitle)]',
                        isCodexAgentCard || useCompactTerminalCard ? 'truncate whitespace-nowrap' : 'break-all'
                    )}>
                        {truncate(subtitle, 160)}
                    </CardDescription>
                ) : null}
            </div>

            <div className={cn(
                'flex shrink-0 items-center gap-2 self-center text-[var(--app-hint)]',
                subtitle ? '-translate-y-0.5' : null
            )}>
                {subagentModel ? (
                    <span
                        className="inline-block max-w-28 truncate rounded-full bg-[var(--app-subtle-bg)] px-1.5 py-px font-mono text-[10px] leading-tight text-[var(--app-hint)] sm:max-w-40"
                        title={subagentModel}
                    >
                        {subagentModel}
                    </span>
                ) : null}
                <ElapsedView from={runningFrom} active={props.block.tool.state === 'running'} />
                <span className={stateColor}>
                    <ToolStatusIcon state={props.block.tool.state} />
                </span>
                <span className="text-[var(--app-hint)]">
                    <DetailsIcon />
                </span>
            </div>
        </div>
    )

    return (
        <Card className="overflow-hidden rounded-[20px] bg-[var(--app-tool-card-bg)] shadow-none">
            <CardHeader className={cn('space-y-0 p-3', subtitle ? 'pb-2' : null)}>
                <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
                    <DialogTrigger asChild>
                        <button
                            type="button"
                            className={cn(
                                'w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                suppressFocusRing && 'focus-visible:ring-0'
                            )}
                            onPointerDown={onTriggerPointerDown}
                            onKeyDown={onTriggerKeyDown}
                            onBlur={onTriggerBlur}
                        >
                            {header}
                        </button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl" aria-describedby={undefined}>
                        <DialogHeader>
                            <DialogTitle>{toolTitle}</DialogTitle>
                        </DialogHeader>
                        <ToolDetailDialogContent block={props.block} metadata={props.metadata} />
                    </DialogContent>
                </Dialog>
            </CardHeader>

            {hasBody ? (
                <CardContent className="px-3 pb-3 pt-1">
                    {taskSummary ? (
                        <div className="mt-2">
                            {taskSummary}
                        </div>
                    ) : null}

                    {showInline ? (
                        CompactToolView ? (
                            <div
                                className="mt-3 cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                role="button"
                                tabIndex={0}
                                onClick={openDetailsFromInlinePreview}
                                onKeyDown={openDetailsFromInlinePreviewKeyDown}
                            >
                                <CompactToolView block={props.block} metadata={props.metadata} surface="inline" />
                            </div>
                        ) : (
                            <div className="mt-3 flex flex-col gap-3">
                                <div
                                    className="cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    role="button"
                                    tabIndex={0}
                                    onClick={openDetailsFromInlinePreview}
                                    onKeyDown={openDetailsFromInlinePreviewKeyDown}
                                >
                                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.input')}</div>
                                    {renderToolInput(props.block, 'inline')}
                                </div>
                                <div
                                    className="cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    role="button"
                                    tabIndex={0}
                                    onClick={openDetailsFromInlinePreview}
                                    onKeyDown={openDetailsFromInlinePreviewKeyDown}
                                >
                                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</div>
                                    <ResultToolView block={props.block} metadata={props.metadata} surface="inline" />
                                </div>
                            </div>
                        )
                    ) : null}

                    {isAskUserQuestion && permission?.status === 'pending' ? (
                        <AskUserQuestionFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    ) : isRequestUserInput && permission?.status === 'pending' ? (
                        <RequestUserInputFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    ) : (
                        <PermissionFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            metadata={props.metadata}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    )}
                </CardContent>
            ) : null}
        </Card>
    )
}

export const ToolCard = memo(ToolCardInner)
