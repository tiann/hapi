import type { ToolViewComponent, ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { extractAskUserQuestionQuestionsInfo } from '@/components/ToolCard/askUserQuestion'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

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

function extractTextFromContentBlock(block: unknown): string | null {
    if (typeof block === 'string') return block
    if (!isObject(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (typeof block.text === 'string') return block.text
    return null
}

function extractTextFromResult(result: unknown, depth: number = 0): string | null {
    if (depth > 2) return null
    if (result === null || result === undefined) return null
    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        return toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
    }

    if (Array.isArray(result)) {
        const parts = result
            .map(extractTextFromContentBlock)
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
        return parts.length > 0 ? parts.join('\n') : null
    }

    if (!isObject(result)) return null

    if (typeof result.content === 'string') return result.content
    if (typeof result.text === 'string') return result.text
    if (typeof result.output === 'string') return result.output
    if (typeof result.error === 'string') return result.error
    if (typeof result.message === 'string') return result.message

    const contentArray = Array.isArray(result.content) ? result.content : null
    if (contentArray) {
        const parts = contentArray
            .map(extractTextFromContentBlock)
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
        return parts.length > 0 ? parts.join('\n') : null
    }

    const nestedOutput = isObject(result.output) ? result.output : null
    if (nestedOutput) {
        if (typeof nestedOutput.content === 'string') return nestedOutput.content
        if (typeof nestedOutput.text === 'string') return nestedOutput.text
    }

    const nestedError = isObject(result.error) ? result.error : null
    if (nestedError) {
        if (typeof nestedError.message === 'string') return nestedError.message
        if (typeof nestedError.error === 'string') return nestedError.error
    }

    const nestedResult = isObject(result.result) ? result.result : null
    if (nestedResult) {
        const nestedText = extractTextFromResult(nestedResult, depth + 1)
        if (nestedText) return nestedText
    }

    const nestedData = isObject(result.data) ? result.data : null
    if (nestedData) {
        const nestedText = extractTextFromResult(nestedData, depth + 1)
        if (nestedText) return nestedText
    }

    return null
}

function looksLikeHtml(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div') || trimmed.startsWith('<span')
}

function looksLikeJson(text: string): boolean {
    const trimmed = text.trim()
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function renderText(text: string, opts: { mode: 'markdown' | 'code' | 'auto'; language?: string } = { mode: 'auto' }) {
    if (opts.mode === 'code') {
        return <CodeBlock code={text} language={opts.language ?? 'text'} />
    }

    if (opts.mode === 'markdown') {
        return <MarkdownRenderer content={text} />
    }

    if (looksLikeHtml(text) || looksLikeJson(text)) {
        return <CodeBlock code={text} language={looksLikeJson(text) ? 'json' : 'html'} />
    }

    return <MarkdownRenderer content={text} />
}

function placeholderForState(state: ToolViewProps['block']['tool']['state']): string {
    if (state === 'pending') return 'Waiting for permission…'
    if (state === 'running') return 'Running…'
    return '(no output)'
}

function RawJsonDevOnly(props: { value: unknown }) {
    if (!import.meta.env.DEV) return null
    if (props.value === null || props.value === undefined) return null

    return (
        <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-[var(--app-hint)]">
                Raw JSON
            </summary>
            <div className="mt-2">
                <CodeBlock code={safeStringify(props.value)} language="json" />
            </div>
        </details>
    )
}

function extractStdoutStderr(result: unknown): { stdout: string | null; stderr: string | null } | null {
    if (!isObject(result)) return null

    const stdout = typeof result.stdout === 'string' ? result.stdout : null
    const stderr = typeof result.stderr === 'string' ? result.stderr : null
    if (stdout !== null || stderr !== null) {
        return { stdout, stderr }
    }

    const nested = isObject(result.output) ? result.output : null
    if (nested) {
        const nestedStdout = typeof nested.stdout === 'string' ? nested.stdout : null
        const nestedStderr = typeof nested.stderr === 'string' ? nested.stderr : null
        if (nestedStdout !== null || nestedStderr !== null) {
            return { stdout: nestedStdout, stderr: nestedStderr }
        }
    }

    return null
}

function extractReadFileContent(result: unknown): { filePath: string | null; content: string } | null {
    if (!isObject(result)) return null
    const file = isObject(result.file) ? result.file : null
    if (!file) return null

    const content = typeof file.content === 'string' ? file.content : null
    if (content === null) return null

    const filePath = typeof file.filePath === 'string'
        ? file.filePath
        : typeof file.file_path === 'string'
            ? file.file_path
            : null

    return { filePath, content }
}

function extractLineList(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

function isProbablyMarkdownList(text: string): boolean {
    const trimmed = text.trimStart()
    return trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('1. ')
}

const AskUserQuestionResultView: ToolViewComponent = (props: ToolViewProps) => {
    const answers = props.block.tool.permission?.answers ?? null
    if (!answers || Object.keys(answers).length === 0) {
        return <MarkdownResultView {...props} />
    }

    const questions = extractAskUserQuestionQuestionsInfo(props.block.tool.input)
    const keys = Object.keys(answers).sort((a, b) => {
        const aNum = Number.parseInt(a, 10)
        const bNum = Number.parseInt(b, 10)
        if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum
        if (Number.isFinite(aNum)) return -1
        if (Number.isFinite(bNum)) return 1
        return a.localeCompare(b)
    })

    return (
        <div className="flex flex-col gap-2">
            {keys.map((key) => {
                const idx = Number.parseInt(key, 10)
                const q = questions && Number.isFinite(idx) ? questions[idx] : null
                const header = q?.header ?? (Number.isFinite(idx) ? `Question ${idx + 1}` : `Question ${key}`)
                const values = answers[key] ?? []
                const cleaned = values.map((v) => String(v)).map((v) => v.trim()).filter((v) => v.length > 0)

                return (
                    <div key={key} className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2">
                        <div className="text-xs font-medium text-[var(--app-hint)] break-words">
                            {header}
                        </div>
                        {q?.question ? (
                            <div className="mt-1 text-xs text-[var(--app-hint)] break-words">
                                {q.question}
                            </div>
                        ) : null}
                        {cleaned.length > 0 ? (
                            <ul className="mt-2 list-disc pl-5 text-sm text-[var(--app-fg)]">
                                {cleaned.map((v, i) => (
                                    <li key={i} className="break-words">{v}</li>
                                ))}
                            </ul>
                        ) : (
                            <div className="mt-2 text-sm text-[var(--app-hint)]">
                                (no answer)
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

const BashResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    if (typeof result === 'string') {
        const toolUseError = parseToolUseError(result)
        const display = toolUseError.isToolUseError ? (toolUseError.errorMessage ?? '') : result
        return (
            <>
                <CodeBlock code={display} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const stdio = extractStdoutStderr(result)
    if (stdio) {
        return (
            <>
                <div className="flex flex-col gap-2">
                    {stdio.stdout ? <CodeBlock code={stdio.stdout} language="text" /> : null}
                    {stdio.stderr ? <CodeBlock code={stdio.stderr} language="text" /> : null}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'text' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MarkdownResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const LineListResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (!text) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (isProbablyMarkdownList(text)) {
        return (
            <>
                <MarkdownRenderer content={text} />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const lines = extractLineList(text)
    if (lines.length === 0) {
        return (
            <>
                <div className="text-sm text-[var(--app-hint)]">(no output)</div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="flex flex-col gap-1">
                {lines.map((line) => (
                    <div key={line} className="text-sm font-mono text-[var(--app-fg)] break-all">
                        {line}
                    </div>
                ))}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const ReadResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const file = extractReadFileContent(result)
    if (file) {
        const path = file.filePath ? resolveDisplayPath(file.filePath, props.metadata) : null
        return (
            <>
                {path ? (
                    <div className="mb-2 text-xs text-[var(--app-hint)] font-mono break-all">
                        {basename(path)}
                    </div>
                ) : null}
                <CodeBlock code={file.content} language="text" />
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'text' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const MutationResultView: ToolViewComponent = (props: ToolViewProps) => {
    const { state, result } = props.block.tool

    if (result === undefined || result === null) {
        if (state === 'completed') {
            return <div className="text-sm text-[var(--app-hint)]">Done</div>
        }
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(state)}</div>
    }

    const text = extractTextFromResult(result)
    if (typeof text === 'string' && text.trim().length > 0) {
        const className = state === 'error' ? 'text-red-600' : 'text-[var(--app-fg)]'
        return (
            <>
                <div className={`text-sm ${className}`}>
                    {renderText(text, { mode: state === 'error' ? 'code' : 'auto' })}
                </div>
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">
                {state === 'completed' ? 'Done' : '(no output)'}
            </div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexPatchResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexReasoningResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">(no output)</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

const CodexDiffResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result
    if (result === undefined || result === null) {
        return props.block.tool.state === 'completed'
            ? <div className="text-sm text-[var(--app-hint)]">Done</div>
            : <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'code', language: 'diff' })}
                <RawJsonDevOnly value={result} />
            </>
        )
    }

    return (
        <>
            <div className="text-sm text-[var(--app-hint)]">Done</div>
            <RawJsonDevOnly value={result} />
        </>
    )
}

type TodoItem = {
    id?: string
    content?: string
    status?: 'pending' | 'in_progress' | 'completed'
    priority?: 'high' | 'medium' | 'low'
}

function extractTodos(input: unknown, result: unknown): TodoItem[] {
    const todosFromInput = isObject(input) && Array.isArray(input.todos)
        ? input.todos.filter(isObject)
        : []
    if (todosFromInput.length > 0) {
        return todosFromInput.map((t) => ({
            id: typeof t.id === 'string' ? t.id : undefined,
            content: typeof t.content === 'string' ? t.content : undefined,
            status: t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' ? t.status : undefined,
            priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : undefined
        }))
    }

    const newTodos = isObject(result) && Array.isArray(result.newTodos)
        ? result.newTodos.filter(isObject)
        : []
    return newTodos.map((t) => ({
        id: typeof t.id === 'string' ? t.id : undefined,
        content: typeof t.content === 'string' ? t.content : undefined,
        status: t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' ? t.status : undefined,
        priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : undefined
    }))
}

function todoTone(todo: TodoItem): string {
    if (todo.status === 'completed') return 'text-emerald-600 line-through'
    if (todo.status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function todoIcon(todo: TodoItem): string {
    if (todo.status === 'completed') return '☑'
    return '☐'
}

const TodoWriteResultView: ToolViewComponent = (props: ToolViewProps) => {
    const todos = extractTodos(props.block.tool.input, props.block.tool.result)
    if (todos.length === 0) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    return (
        <div className="flex flex-col gap-1">
            {todos.map((todo, idx) => {
                const text = todo.content?.trim() ? todo.content.trim() : '(empty)'
                return (
                    <div key={todo.id ?? String(idx)} className={`text-sm ${todoTone(todo)}`}>
                        {todoIcon(todo)} {text}
                    </div>
                )
            })}
        </div>
    )
}

const GenericResultView: ToolViewComponent = (props: ToolViewProps) => {
    const result = props.block.tool.result

    if (result === undefined || result === null) {
        return <div className="text-sm text-[var(--app-hint)]">{placeholderForState(props.block.tool.state)}</div>
    }

    const text = extractTextFromResult(result)
    if (text) {
        return (
            <>
                {renderText(text, { mode: 'auto' })}
                {typeof result === 'object' ? <RawJsonDevOnly value={result} /> : null}
            </>
        )
    }

    if (typeof result === 'string') {
        return renderText(result, { mode: 'auto' })
    }

    return <CodeBlock code={safeStringify(result)} language="json" />
}

export const toolResultViewRegistry: Record<string, ToolViewComponent> = {
    Task: MarkdownResultView,
    Bash: BashResultView,
    CodexBash: BashResultView,
    Glob: LineListResultView,
    Grep: LineListResultView,
    LS: LineListResultView,
    Read: ReadResultView,
    Edit: MutationResultView,
    MultiEdit: MutationResultView,
    Write: MutationResultView,
    WebFetch: MarkdownResultView,
    WebSearch: MarkdownResultView,
    NotebookRead: ReadResultView,
    NotebookEdit: MutationResultView,
    TodoWrite: TodoWriteResultView,
    CodexReasoning: CodexReasoningResultView,
    CodexPatch: CodexPatchResultView,
    CodexDiff: CodexDiffResultView,
    AskUserQuestion: AskUserQuestionResultView,
    ExitPlanMode: MarkdownResultView,
    ask_user_question: AskUserQuestionResultView,
    exit_plan_mode: MarkdownResultView
}

export function getToolResultViewComponent(toolName: string): ToolViewComponent {
    if (toolName.startsWith('mcp__')) {
        return GenericResultView
    }
    return toolResultViewRegistry[toolName] ?? GenericResultView
}
