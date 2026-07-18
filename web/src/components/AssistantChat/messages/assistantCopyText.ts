import type { ThreadAssistantMessagePart } from '@assistant-ui/react'

function isCopyableTextPart(part: ThreadAssistantMessagePart): part is ThreadAssistantMessagePart & { text: string } {
    return part.type === 'text' && 'text' in part && typeof part.text === 'string'
}

export function getAssistantCopyText(parts: readonly ThreadAssistantMessagePart[]): string {
    return parts
        .filter(isCopyableTextPart)
        .map((part) => part.text.trim())
        .filter((text) => text.length > 0)
        .join('\n\n')
}
