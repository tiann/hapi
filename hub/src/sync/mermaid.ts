import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

// Diagram types recognised by mermaid v11. Checked case-insensitively against
// the first token of each ```mermaid block.
const KNOWN_DIAGRAM_TYPES = new Set([
    'flowchart',
    'graph',
    'sequencediagram',
    'classdiagram',
    'statediagram',
    'statediagram-v2',
    'erdiagram',
    'gantt',
    'journey',
    'gitgraph',
    'pie',
    'quadrantchart',
    'requirementdiagram',
    'mindmap',
    'timeline',
    'sankey-beta',
    'xychart-beta',
    'block-beta',
    'packet-beta',
    'architecture-beta',
    'c4context',
    'c4container',
    'c4component',
    'c4dynamic',
    'c4deployment',
    'zenuml',
    'kanban',
])

export interface MermaidIssue {
    snippet: string
}

function extractTextFromContent(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    const parts: string[] = []
    for (const block of content) {
        if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text)
        }
    }
    return parts.length > 0 ? parts.join('\n') : null
}

function getDiagramType(code: string): string {
    for (const line of code.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('%%')) continue
        return trimmed.split(/\s/)[0].toLowerCase()
    }
    return ''
}

function findInvalidMermaidBlocks(markdown: string): MermaidIssue[] {
    const issues: MermaidIssue[] = []
    // Match ```mermaid fences; multiline, anchored to line start
    const fenceRegex = /^```mermaid[ \t]*\r?\n([\s\S]*?)^```/gm
    let match: RegExpExecArray | null
    while ((match = fenceRegex.exec(markdown)) !== null) {
        const code = match[1]
        const diagramType = getDiagramType(code)
        if (!diagramType || !KNOWN_DIAGRAM_TYPES.has(diagramType)) {
            issues.push({ snippet: code.slice(0, 500) })
        }
    }
    return issues
}

/**
 * Inspects a message content blob (as stored in the hub DB) and returns one
 * entry per ```mermaid block whose first token is not a recognised diagram
 * type. Only processes assistant-role messages; returns [] for everything else.
 */
export function extractFailingMermaidBlocks(messageContent: unknown): MermaidIssue[] {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record || record.role !== 'assistant') return []

    const text = extractTextFromContent(record.content)
    if (!text) return []

    return findInvalidMermaidBlocks(text)
}

export function buildMermaidRenderIssueHint(issues: MermaidIssue[]): string {
    const blocks = issues
        .map((issue, i) => {
            const label = issues.length > 1 ? `Block ${i + 1}:\n` : ''
            return `${label}\`\`\`\n${issue.snippet.trim()}\n\`\`\``
        })
        .join('\n\n')
    const noun = issues.length === 1 ? 'block' : 'blocks'
    return (
        `<render-issue>\n` +
        `A mermaid ${noun} in your previous response could not be rendered — ` +
        `the diagram type was not recognised. The user saw it as raw text.\n\n` +
        `${blocks}\n\n` +
        `If the diagram was intended, please re-emit it with corrected syntax.\n` +
        `</render-issue>`
    )
}
