import type { ComponentType } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { CodexDiffCompactView, CodexDiffFullView } from '@/components/ToolCard/views/CodexDiffView'
import { CodexPatchView } from '@/components/ToolCard/views/CodexPatchView'
import { EditView } from '@/components/ToolCard/views/EditView'
import { AskUserQuestionView } from '@/components/ToolCard/views/AskUserQuestionView'
import { RequestUserInputView } from '@/components/ToolCard/views/RequestUserInputView'
import { ExitPlanModeView } from '@/components/ToolCard/views/ExitPlanModeView'
import { MultiEditFullView, MultiEditView } from '@/components/ToolCard/views/MultiEditView'
import { TodoWriteView } from '@/components/ToolCard/views/TodoWriteView'
import { UpdatePlanView } from '@/components/ToolCard/views/UpdatePlanView'
import { WriteView } from '@/components/ToolCard/views/WriteView'
import { getInputStringAny } from '@/lib/toolInputUtils'
import {
    getCodexAgentFieldRows,
    getCodexAgentPrompt,
    summarizeCodexAgentResult
} from '@/components/ToolCard/codexAgents'

export type ToolViewProps = {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
    surface?: 'inline' | 'dialog'
}

export type ToolViewComponent = ComponentType<ToolViewProps>

const SkillFullView: ToolViewComponent = ({ block }: ToolViewProps) => {
    const skillName = getInputStringAny(block.tool.input, ['skill'])
    return (
        <div className="text-sm text-[var(--app-fg)]">
            {skillName ?? 'Unknown skill'}
        </div>
    )
}

const CodexAgentView: ToolViewComponent = ({ block, surface }: ToolViewProps) => {
    const input = block.tool.input
    const rows = getCodexAgentFieldRows(block.tool.name, input)
    const prompt = getCodexAgentPrompt(input)
    const resultSummary = surface === 'inline'
        ? summarizeCodexAgentResult(block.tool.name, block.tool.result)
        : null

    return (
        <div className="flex flex-col gap-2 text-sm">
            {surface === 'dialog' && prompt ? (
                <div className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-[var(--app-fg)]">
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                        Prompt
                    </div>
                    <div className="whitespace-pre-wrap break-words">{prompt}</div>
                </div>
            ) : null}
            {rows.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {rows.map((row) => (
                        <span
                            key={`${row.label}:${row.value}`}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
                        >
                            <span className="font-medium text-[var(--app-fg)]">{row.label}:</span>
                            <span className="truncate font-mono">{row.value}</span>
                        </span>
                    ))}
                </div>
            ) : null}
            {resultSummary ? (
                <div className="text-xs text-[var(--app-hint)]">{resultSummary}</div>
            ) : null}
        </div>
    )
}

export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    MultiEdit: MultiEditView,
    Write: WriteView,
    TodoWrite: TodoWriteView,
    update_plan: UpdatePlanView,
    CodexDiff: CodexDiffCompactView,
    CodexAgent: CodexAgentView,
    spawn_agent: CodexAgentView,
    send_input: CodexAgentView,
    resume_agent: CodexAgentView,
    wait_agent: CodexAgentView,
    close_agent: CodexAgentView,
    AskUserQuestion: AskUserQuestionView,
    ExitPlanMode: ExitPlanModeView,
    ask_user_question: AskUserQuestionView,
    exit_plan_mode: ExitPlanModeView,
    request_user_input: RequestUserInputView
}

export const toolFullViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    MultiEdit: MultiEditFullView,
    Write: WriteView,
    CodexDiff: CodexDiffFullView,
    CodexPatch: CodexPatchView,
    CodexAgent: CodexAgentView,
    Skill: SkillFullView,
    spawn_agent: CodexAgentView,
    send_input: CodexAgentView,
    resume_agent: CodexAgentView,
    wait_agent: CodexAgentView,
    close_agent: CodexAgentView,
    AskUserQuestion: AskUserQuestionView,
    ExitPlanMode: ExitPlanModeView,
    ask_user_question: AskUserQuestionView,
    exit_plan_mode: ExitPlanModeView,
    request_user_input: RequestUserInputView
}

export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return toolViewRegistry[toolName] ?? null
}

export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return toolFullViewRegistry[toolName] ?? null
}
