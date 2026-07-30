/**
 * Convert bare `/sessions/<id>` paths in markdown text into links so citations
 * from Copy reference / @-mention autocomplete are clickable in chat.
 *
 * Id segment excludes `.` so paths like `routes/sessions/chat.tsx` remain for
 * `remarkFilePathLinks` (plugin order: session links before file links).
 */

import { parseSessionPathHref } from '@/lib/sessionReference'

type MarkdownNode = {
    type?: string
    value?: string
    url?: string
    title?: string | null
    children?: MarkdownNode[]
}

// Optional leading BASE_URL segment(s), then sessions/<id> (no dots in id).
// Do not treat `.` as a soft end when it starts a file extension (`.tsx`).
const BARE_SESSION_PATH =
    /(?:^|[\s(])((?:\.?\/)?(?:[\w.-]+\/)*sessions\/[A-Za-z0-9_~%-]+)(?=[\s),;:!?]|$(?!\.)|(?=\.(?:[\s),;:!?]|$)))/g

function linkifyTextNode(node: MarkdownNode): MarkdownNode[] {
    const value = node.value ?? ''
    if (!value.includes('sessions/')) return [node]

    const parts: MarkdownNode[] = []
    let lastIndex = 0
    BARE_SESSION_PATH.lastIndex = 0

    for (const match of value.matchAll(BARE_SESSION_PATH)) {
        const full = match[0] ?? ''
        const path = match[1] ?? ''
        const matchIndex = match.index ?? 0
        const pathStartInFull = full.indexOf(path)
        const absoluteStart = matchIndex + pathStartInFull
        const absoluteEnd = absoluteStart + path.length

        if (!parseSessionPathHref(path)) continue

        if (absoluteStart > lastIndex) {
            parts.push({ type: 'text', value: value.slice(lastIndex, absoluteStart) })
        }
        parts.push({
            type: 'link',
            url: path.startsWith('/') || path.startsWith('./') ? path : `/${path}`,
            title: null,
            children: [{ type: 'text', value: path }],
        })
        lastIndex = absoluteEnd
    }

    if (parts.length === 0) return [node]
    if (lastIndex < value.length) {
        parts.push({ type: 'text', value: value.slice(lastIndex) })
    }
    return parts
}

function walk(node: MarkdownNode, parentIsLink: boolean): void {
    if (!node.children?.length) return
    const next: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'text' && !parentIsLink && node.type !== 'code' && node.type !== 'inlineCode') {
            next.push(...linkifyTextNode(child))
        } else {
            walk(child, parentIsLink || child.type === 'link')
            next.push(child)
        }
    }
    node.children = next
}

export function remarkSessionPathLinks() {
    return (tree: MarkdownNode) => {
        walk(tree, false)
    }
}
