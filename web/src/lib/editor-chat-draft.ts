export function buildAddFileToChatText(filePath: string): string {
    return `@${filePath.trim()}`
}

export function buildAddSelectionToChatText(filePath: string, startLine: number, endLine: number): string {
    if (startLine === endLine) {
        return `@${filePath.trim()}:${startLine}`
    }
    return `@${filePath.trim()}:${startLine}-${endLine}`
}

export function buildExpandSelectionBlock(filePath: string, startLine: number, endLine: number, content: string): string {
    const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
    return `\n\`\`\`${filePath} (${lines})\n${content}\n\`\`\`\n`
}

/** Reference pattern: @path/to/file or @path/to/file:line or @path/to/file:start-end */
const SELECTION_REF_PATTERN = /(@[^\s:]+(?::\d+(?:-\d+)?)?)(?=\s|$)/g

export function expandSelectionRefs(text: string, selectionMap: Map<string, { path: string; start: number; end: number; content: string }>): string {
    return text.replace(SELECTION_REF_PATTERN, (match, refKey) => {
        const entry = selectionMap.get(refKey)
        if (entry) {
            return buildExpandSelectionBlock(entry.path, entry.start, entry.end, entry.content)
        }
        return match
    })
}

export function appendEditorChatDraft(currentDraft: string, filePath: string): string {
    const token = buildAddFileToChatText(filePath)
    const draft = currentDraft.trimEnd()

    if (draft.length === 0) {
        return token
    }

    const existingTokens = draft.split(/\s+/)
    if (existingTokens.includes(token)) {
        return draft
    }

    return `${draft}\n${token}`
}

export function appendEditorChatDraftWithSelection(
    currentDraft: string,
    filePath: string,
    startLine: number,
    endLine: number
): string {
    const token = buildAddSelectionToChatText(filePath, startLine, endLine)
    const cleanedToken = token.replace(/^@/, '') // Remove @ for dedup check with full token
    const draft = currentDraft.trimEnd()

    if (draft.length === 0) {
        return token
    }

    const existingTokens = draft.split(/\s+/)
    if (existingTokens.includes(token) || existingTokens.includes(`@${cleanedToken}`)) {
        return draft
    }

    return `${draft}\n${token}`
}
