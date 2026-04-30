export function buildAddFileToChatText(filePath: string): string {
    return `@${filePath.trim()}`
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
