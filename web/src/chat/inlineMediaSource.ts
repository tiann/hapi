/** v1 inline media provenance (wire + chat blocks). See cli/src/modules/common/inlineMediaSource.ts */
export type InlineMediaIngress = 'mcp' | 'acp' | 'tool_result' | 'attachment-fallback'

export type InlineMediaSource = {
    ingress: InlineMediaIngress
    flavor?: string
    toolCallId?: string
    toolName?: string
    isMarkdownImage?: boolean
    linkTarget?: string
}

export function inlineMediaSourceFromWire(value: unknown): InlineMediaSource | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const ingress = record.ingress ?? record.path
    if (ingress !== 'mcp' && ingress !== 'acp' && ingress !== 'tool_result' && ingress !== 'attachment-fallback') return undefined
    const flavor = typeof record.flavor === 'string' ? record.flavor : undefined
    const toolCallId = typeof record.toolCallId === 'string'
        ? record.toolCallId
        : typeof record.tool_call_id === 'string'
            ? record.tool_call_id
            : undefined
    const toolName = typeof record.toolName === 'string'
        ? record.toolName
        : typeof record.tool_name === 'string'
            ? record.tool_name
            : undefined
    const isMarkdownImage = typeof record.isMarkdownImage === 'boolean' ? record.isMarkdownImage : undefined
    const linkTarget = typeof record.linkTarget === 'string' ? record.linkTarget : undefined
    return { ingress, flavor, toolCallId, toolName, isMarkdownImage, linkTarget }
}

/** Structural equality — wire normalization always allocates a fresh object. */
export function areInlineMediaSourcesEqual(left?: InlineMediaSource, right?: InlineMediaSource): boolean {
    if (left === right) return true
    if (!left || !right) return false
    return left.ingress === right.ingress
        && left.flavor === right.flavor
        && left.toolCallId === right.toolCallId
        && left.toolName === right.toolName
        && left.isMarkdownImage === right.isMarkdownImage
        && left.linkTarget === right.linkTarget
}
