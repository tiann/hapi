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

export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    MultiEdit: MultiEditView,
    Write: WriteView,
    TodoWrite: TodoWriteView,
    update_plan: UpdatePlanView,
    CodexDiff: CodexDiffCompactView,
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
    Skill: SkillFullView,
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
