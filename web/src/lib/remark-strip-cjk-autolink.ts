/**
 * Remark plugin that stops bare auto-linked URLs at CJK/fullwidth punctuation.
 *
 * GFM can swallow punctuation, following prose and closing emphasis delimiters
 * into a URL. Move the suffix out and repair a matching emphasis wrapper.
 */
// The CJK Symbols and Punctuation block also contains letters, numbers and
// combining marks (e.g. 々), which may be valid URL path characters.
const CJK_PUNCT = /(?![\p{L}\p{M}\p{N}])[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u2018-\u201F\u2026]/u
// Keep bracket-only suffixes that may be part of the URL (#479/#486).
const BRACKETS_ONLY = /^[（）［］｛｝＜＞〈〉《》「」『』【】〔〕〖〗〘〙〚〛｟｠｢｣]+$/
const TRAILING_ASCII_PUNCT = /[*_~.,:;!?'"]+$/

interface MdastNode {
    type: string
    url?: string
    value?: string
    children?: MdastNode[]
    position?: { start: { offset?: number } }
}

function emphasisType(delimiter: string | undefined): 'strong' | 'emphasis' | 'delete' | undefined {
    if (delimiter === '**' || delimiter === '__') return 'strong'
    if (delimiter === '*' || delimiter === '_') return 'emphasis'
    if (delimiter === '~~') return 'delete'
    return undefined
}

function visitLinks(node: MdastNode): void {
    const children = node.children
    if (!children) return

    for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child.type !== 'link') {
            visitLinks(child)
            continue
        }

        const url = child.url
        const textChild = child.children?.[0]
        if (typeof url !== 'string' || child.children?.length !== 1
            || textChild?.type !== 'text' || typeof textChild.value !== 'string') continue

        // GFM www. literals have an implicit http:// prefix in the URL.
        const text = textChild.value
        if (text !== url && !(/^www\./i.test(text) && url === `http://${text}`)) continue

        // Explicit [url](url) links and <url> autolinks have a different
        // start offset from their label. Synthetic non-HTTPS links omit positions.
        const linkStart = child.position?.start.offset
        const textStart = textChild.position?.start.offset
        if (linkStart !== undefined && textStart !== undefined && linkStart !== textStart) continue

        const boundary = url.search(CJK_PUNCT)
        if (boundary === -1) continue

        const trimmed = url.slice(0, boundary).replace(TRAILING_ASCII_PUNCT, '')
        let tail = url.slice(trimmed.length)

        // Only pair entire, identical delimiter runs in adjacent siblings.
        const previous = children[i - 1]
        const previousText = previous?.type === 'text' ? previous.value : undefined
        const opening = previousText?.match(/([*_~])\1*$/)?.[0]
        const closing = tail.match(/^([*_~])\1*/)?.[0]
        const wrapper = opening === closing ? emphasisType(opening) : undefined

        if (BRACKETS_ONLY.test(url.slice(boundary)) && !wrapper) continue

        child.url = trimmed
        textChild.value = text.slice(0, -tail.length)

        if (wrapper && opening && previousText !== undefined) {
            previous.value = previousText.slice(0, -opening.length)
            children[i] = { type: wrapper, children: [child] }
            tail = tail.slice(opening.length)
            if (!previous.value) {
                children.splice(i - 1, 1)
                i--
            }
        }

        children.splice(i + 1, 0, { type: 'text', value: tail })
        i++ // Skip the newly inserted text node.
    }
}

export default function remarkStripCjkAutolink() {
    return (tree: MdastNode) => {
        visitLinks(tree)
    }
}
