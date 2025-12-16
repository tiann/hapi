import type { ToolCallBlock } from '@/chat/types'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { useEffect, useState, type ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { DiffView } from '@/components/DiffView'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { getToolPresentation } from '@/components/ToolCard/knownTools'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function parseToolUseError(message: string): { isToolUseError: boolean; errorMessage: string | null } {
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s
    const match = message.match(regex)

    if (match) {
        return {
            isToolUseError: true,
            errorMessage: typeof match[1] === 'string' ? match[1].trim() : ''
        }
    }

    return { isToolUseError: false, errorMessage: null }
}

function getInputString(input: unknown, key: string): string | null {
    if (!isObject(input)) return null
    const value = input[key]
    return typeof value === 'string' ? value : null
}

function getInputStringAny(input: unknown, keys: string[]): string | null {
    for (const key of keys) {
        const value = getInputString(input, key)
        if (value) return value
    }
    return null
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

function ElapsedView(props: { from: number; active: boolean }) {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!props.active) return
        const id = setInterval(() => setNow(Date.now()), 250)
        return () => clearInterval(id)
    }, [props.active])

    if (!props.active) return null

    const elapsed = (now - props.from) / 1000
    if (!Number.isFinite(elapsed)) return null

    return (
        <span className="font-mono text-xs text-[var(--app-hint)]">
            {elapsed.toFixed(1)}s
        </span>
    )
}

function formatTaskChildLabel(child: ToolCallBlock): string {
    const presentation = getToolPresentation({
        toolName: child.tool.name,
        input: child.tool.input,
        childrenCount: child.children.length,
        description: child.tool.description
    })

    if (presentation.subtitle) {
        return truncate(`${presentation.title}: ${presentation.subtitle}`, 140)
    }

    return presentation.title
}

function TaskStateIcon(props: { state: ToolCallBlock['tool']['state'] }) {
    if (props.state === 'completed') {
        return <span className="text-emerald-600">✓</span>
    }
    if (props.state === 'error') {
        return <span className="text-red-600">✕</span>
    }
    if (props.state === 'pending') {
        return <span className="text-amber-600">🔐</span>
    }
    return <span className="text-amber-600 animate-pulse">●</span>
}

function renderTaskSummary(block: ToolCallBlock): ReactNode | null {
    if (block.tool.name !== 'Task') return null

    const children = block.children
        .filter((child): child is ToolCallBlock => child.kind === 'tool-call')
        .filter((child) => child.tool.state === 'pending' || child.tool.state === 'running' || child.tool.state === 'completed' || child.tool.state === 'error')

    if (children.length === 0) return null

    const visible = children.slice(-3)
    const remaining = children.length - visible.length

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
                                {formatTaskChildLabel(child)}
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

function renderEditInput(input: unknown): ReactNode | null {
    if (!isObject(input)) return null
    const filePath = getInputStringAny(input, ['file_path', 'path']) ?? undefined
    const oldString = getInputString(input, 'old_string')
    const newString = getInputString(input, 'new_string')
    if (oldString === null || newString === null) return null

    return (
        <DiffView
            oldString={oldString}
            newString={newString}
            filePath={filePath}
        />
    )
}

function renderExitPlanModeInput(input: unknown): ReactNode | null {
    if (!isObject(input)) return null
    const plan = getInputString(input, 'plan')
    if (!plan) return null
    return <MarkdownRenderer content={plan} />
}

function renderToolInput(block: ToolCallBlock): ReactNode {
    const toolName = block.tool.name
    const input = block.tool.input

    if (toolName === 'Task' && isObject(input) && typeof input.prompt === 'string') {
        return <MarkdownRenderer content={input.prompt} />
    }

    if (toolName === 'Edit') {
        const diff = renderEditInput(input)
        if (diff) return diff
    }

    if (toolName === 'MultiEdit' && isObject(input)) {
        const filePath = getInputStringAny(input, ['file_path', 'path']) ?? undefined
        const edits = Array.isArray(input.edits) ? input.edits : null
        if (edits && edits.length > 0) {
            const rendered = edits
                .slice(0, 3)
                .map((edit, idx) => {
                    if (!isObject(edit)) return null
                    const oldString = getInputString(edit, 'old_string')
                    const newString = getInputString(edit, 'new_string')
                    if (oldString === null || newString === null) return null
                    return (
                        <div key={idx}>
                            <DiffView oldString={oldString} newString={newString} filePath={filePath} />
                        </div>
                    )
                })
                .filter(Boolean)

            if (rendered.length > 0) {
                return (
                    <div className="flex flex-col gap-2">
                        {rendered}
                        {edits.length > 3 ? (
                            <div className="text-xs text-[var(--app-hint)]">
                                (+{edits.length - 3} more edits)
                            </div>
                        ) : null}
                    </div>
                )
            }
        }
    }

    if (toolName === 'Write' && isObject(input)) {
        const filePath = getInputStringAny(input, ['file_path', 'path'])
        const content = getInputStringAny(input, ['content', 'text'])
        if (filePath && content !== null) {
            return (
                <div className="flex flex-col gap-2">
                    <div className="text-xs text-[var(--app-hint)] font-mono break-all">
                        {filePath}
                    </div>
                    <CodeBlock code={content} language="text" />
                </div>
            )
        }
    }

    if (toolName === 'CodexDiff' && isObject(input) && typeof input.unified_diff === 'string') {
        return <CodeBlock code={input.unified_diff} language="diff" />
    }

    if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
        const plan = renderExitPlanModeInput(input)
        if (plan) return plan
    }

    const commandArray = isObject(input) && Array.isArray(input.command) ? input.command : null
    if ((toolName === 'CodexBash' || toolName === 'Bash') && (typeof commandArray?.[0] === 'string' || typeof input === 'object')) {
        const cmd = Array.isArray(commandArray)
            ? commandArray.filter((part) => typeof part === 'string').join(' ')
            : getInputStringAny(input, ['command', 'cmd'])
        if (cmd) {
            return <CodeBlock code={cmd} language="bash" />
        }
    }

    return <CodeBlock code={safeStringify(input)} language="json" />
}

function renderToolResult(block: ToolCallBlock): ReactNode {
    const result = block.tool.result
    const toolName = block.tool.name

    if (result === undefined || result === null) {
        return (
            <div className="text-sm text-[var(--app-hint)]">
                {block.tool.state === 'pending' ? 'Waiting for permission…' : block.tool.state === 'running' ? 'Running…' : '(no output)'}
            </div>
        )
    }

    if ((toolName === 'Bash' || toolName === 'CodexBash') && isObject(result)) {
        const stdout = typeof result.stdout === 'string' ? result.stdout : null
        const stderr = typeof result.stderr === 'string' ? result.stderr : null
        if (stdout !== null || stderr !== null) {
            return (
                <div className="flex flex-col gap-2">
                    {stdout ? <CodeBlock code={stdout} language="text" /> : null}
                    {stderr ? <CodeBlock code={stderr} language="text" /> : null}
                </div>
            )
        }
    }

    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        const display = toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
        return <CodeBlock code={display} language="text" />
    }

    return <CodeBlock code={safeStringify(result)} language="json" />
}

function StatusIcon(props: { state: ToolCallBlock['tool']['state'] }) {
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

function accentBorderClass(state: ToolCallBlock['tool']['state']): string {
    if (state === 'completed') return 'border-l-4 border-l-emerald-500'
    if (state === 'error') return 'border-l-4 border-l-red-500'
    if (state === 'pending') return 'border-l-4 border-l-amber-500'
    return 'border-l-4 border-l-blue-500'
}

function statusColorClass(state: ToolCallBlock['tool']['state']): string {
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

export function ToolCard(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onDone: () => void
    block: ToolCallBlock
}) {
    const presentation = getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        childrenCount: props.block.children.length,
        description: props.block.tool.description
    })

    const toolName = props.block.tool.name
    const toolTitle = presentation.title
    const subtitle = presentation.subtitle ?? props.block.tool.description
    const taskSummary = renderTaskSummary(props.block)
    const accent = accentBorderClass(props.block.tool.state)
    const runningFrom = props.block.tool.startedAt ?? props.block.tool.createdAt
    const showDialog = presentation.minimal || toolName === 'Task'
    const showInline = !presentation.minimal && toolName !== 'Task'
    const hasBody = showInline || taskSummary !== null || Boolean(props.block.tool.permission)
    const stateColor = statusColorClass(props.block.tool.state)

    const header = (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2">
                <div className="shrink-0 text-base leading-none">
                    {presentation.icon}
                </div>
                <div className="min-w-0">
                    <CardTitle className="text-sm font-medium break-words">{toolTitle}</CardTitle>
                    {subtitle ? (
                        <CardDescription className="mt-0.5 font-mono text-xs break-all opacity-80">
                            {truncate(subtitle, 160)}
                        </CardDescription>
                    ) : null}
                </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
                <ElapsedView from={runningFrom} active={props.block.tool.state === 'running'} />
                <span className={stateColor}>
                    <StatusIcon state={props.block.tool.state} />
                </span>
                {showDialog ? (
                    <span className="text-[var(--app-hint)]">
                        <DetailsIcon />
                    </span>
                ) : null}
            </div>
        </div>
    )

    return (
        <Card className={`overflow-hidden shadow-sm ${accent}`}>
            <CardHeader className="p-3 space-y-0">
                {showDialog ? (
                    <Dialog>
                        <DialogTrigger asChild>
                            <button type="button" className="w-full text-left">
                                {header}
                            </button>
                        </DialogTrigger>
                        <DialogContent className="max-w-2xl">
                            <DialogHeader>
                                <DialogTitle>{toolTitle}</DialogTitle>
                            </DialogHeader>
                            <div className="mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto">
                                <div>
                                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Input</div>
                                    {renderToolInput(props.block)}
                                </div>
                                <div>
                                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Result</div>
                                    {renderToolResult(props.block)}
                                </div>
                            </div>
                        </DialogContent>
                    </Dialog>
                ) : (
                    header
                )}
            </CardHeader>

            {hasBody ? (
                <CardContent className="px-3 pb-3 pt-0">
                    {taskSummary ? (
                        <div className="mt-2">
                            {taskSummary}
                        </div>
                    ) : null}

                    {showInline ? (
                        <div className="mt-3 flex flex-col gap-3">
                            <div>
                                <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Input</div>
                                {renderToolInput(props.block)}
                            </div>
                            <div>
                                <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Result</div>
                                {renderToolResult(props.block)}
                            </div>
                        </div>
                    ) : null}

                    <PermissionFooter
                        api={props.api}
                        sessionId={props.sessionId}
                        metadata={props.metadata}
                        tool={props.block.tool}
                        disabled={props.disabled}
                        onDone={props.onDone}
                    />
                </CardContent>
            ) : null}
        </Card>
    )
}
