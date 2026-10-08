import type { ComponentType } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { ChatToolCall, ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { CodexDiffCompactView, CodexDiffFullView } from '@/components/ToolCard/views/CodexDiffView'
import { CodexPatchView } from '@/components/ToolCard/views/CodexPatchView'
import { EditView } from '@/components/ToolCard/views/EditView'
import { AskUserQuestionView } from '@/components/ToolCard/views/AskUserQuestionView'
import { RequestUserInputView } from '@/components/ToolCard/views/RequestUserInputView'
import { ExitPlanModeView } from '@/components/ToolCard/views/ExitPlanModeView'
import { CursorCreatePlanView } from '@/components/ToolCard/views/CursorCreatePlanView'
import { MultiEditFullView, MultiEditView } from '@/components/ToolCard/views/MultiEditView'
import { TodoWriteView } from '@/components/ToolCard/views/TodoWriteView'
import { UpdatePlanView } from '@/components/ToolCard/views/UpdatePlanView'
import { WriteView } from '@/components/ToolCard/views/WriteView'
import { GoalView } from '@/components/ToolCard/views/GoalView'
import { canShowGoalPreview, isGoalToolName } from '@/components/ToolCard/goalTools'
import { getInputStringAny } from '@/lib/toolInputUtils'
import {
    codexAgentCard,
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
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    const rows: Array<{ label: string; value: string; copy?: string | null }> = block.tool.name === 'CodexAgent'
        ? codexAgentCard(input, t, block.tool.result).rows : getCodexAgentFieldRows(block.tool.name, input, t)
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
                <div className="flex min-w-0 flex-col gap-2">
                    {rows.map((row) => (
                        <span
                            key={`${row.label}:${row.value}`}
                            className="flex min-w-0 max-w-full flex-wrap items-baseline gap-1 text-xs text-[var(--app-hint)]"
                        >
                            <span className="font-medium text-[var(--app-fg)]">{row.label}:</span>
                            <span className="min-w-0 whitespace-pre-wrap break-all font-mono">{row.value}</span>
                            {row.copy ? <button type="button" className="shrink-0 rounded border border-[var(--app-border)] px-2 py-1" aria-label={`${t('message.copy')} ${row.label}`} onClick={() => void copy(row.copy!)}>{t(copied ? 'message.copied' : 'message.copy')}</button> : null}
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
    send_message: CodexAgentView,
    resume_agent: CodexAgentView,
    followup_task: CodexAgentView,
    wait_agent: CodexAgentView,
    close_agent: CodexAgentView,
    interrupt_agent: CodexAgentView,
    list_agents: CodexAgentView,
    AskUserQuestion: AskUserQuestionView,
    ExitPlanMode: ExitPlanModeView,
    CursorAskQuestion: AskUserQuestionView,
    CursorCreatePlan: CursorCreatePlanView,
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
    send_message: CodexAgentView,
    resume_agent: CodexAgentView,
    followup_task: CodexAgentView,
    wait_agent: CodexAgentView,
    close_agent: CodexAgentView,
    interrupt_agent: CodexAgentView,
    list_agents: CodexAgentView,
    AskUserQuestion: AskUserQuestionView,
    ExitPlanMode: ExitPlanModeView,
    CursorAskQuestion: AskUserQuestionView,
    CursorCreatePlan: CursorCreatePlanView,
    ask_user_question: AskUserQuestionView,
    exit_plan_mode: ExitPlanModeView,
    request_user_input: RequestUserInputView
}

export function getToolViewComponent(toolName: string, tool?: Pick<ChatToolCall, 'input' | 'result' | 'state'>): ToolViewComponent | null {
    if (isGoalToolName(toolName)) return tool && canShowGoalPreview(tool) ? GoalView : null
    return toolViewRegistry[toolName] ?? null
}

export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return toolFullViewRegistry[toolName] ?? null
}
