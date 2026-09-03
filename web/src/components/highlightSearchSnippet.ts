export type HighlightSnippetPart =
    | { type: 'text'; value: string }
    | { type: 'mark'; value: string }

/**
 * Split a search snippet into plain text and match spans so the UI can
 * highlight the query without trusting HTML from the hub.
 */
export function highlightSearchSnippet(snippet: string, query: string): HighlightSnippetPart[] {
    const text = snippet
    const needle = query.trim()
    if (!text) return []
    if (!needle) return [{ type: 'text', value: text }]

    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'gi')
    const parts: HighlightSnippetPart[] = []
    let cursor = 0
    let match = pattern.exec(text)
    while (match) {
        if (match.index > cursor) {
            parts.push({ type: 'text', value: text.slice(cursor, match.index) })
        }
        parts.push({ type: 'mark', value: match[0] })
        cursor = match.index + match[0].length
        // Avoid zero-length loops on empty matches.
        if (match[0].length === 0) {
            pattern.lastIndex += 1
        }
        match = pattern.exec(text)
    }
    if (cursor < text.length) {
        parts.push({ type: 'text', value: text.slice(cursor) })
    }
    return parts.length > 0 ? parts : [{ type: 'text', value: text }]
}
