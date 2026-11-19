import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { useTranslation } from '@/lib/use-translation'

export function SubagentInspectorDialog(props: {
    block: ToolCallBlock | null
    metadata: SessionMetadataSummary | null
    onClose: () => void
}) {
    const { t } = useTranslation()
    const block = props.block
    const title = block
        ? getToolPresentation({
            toolName: block.tool.name,
            input: block.tool.input,
            result: block.tool.result,
            childrenCount: block.children.length,
            description: block.tool.nativeTitle ?? block.tool.description,
            metadata: props.metadata,
            pending: block.tool.permission?.status === 'pending'
        }, t).title
        : t('session.status.subagents')

    return (
        <Dialog open={Boolean(block)} onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent
                className="max-w-2xl"
                closeButtonClassName="top-2"
                aria-describedby={undefined}
            >
                <DialogHeader className="text-left">
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                {block ? <ToolDetailDialogContent block={block} metadata={props.metadata} /> : null}
            </DialogContent>
        </Dialog>
    )
}
