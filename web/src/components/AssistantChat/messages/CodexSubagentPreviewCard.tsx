import type { ToolCallBlock } from '@/chat/types'
import { SubagentPreviewCard } from '@/components/AssistantChat/messages/SubagentPreviewCard'

export function CodexSubagentPreviewCard(props: { block: ToolCallBlock }) {
    return (
        <SubagentPreviewCard
            block={props.block}
            dialogDescription="Nested child transcript for this Codex subagent run."
        />
    )
}
