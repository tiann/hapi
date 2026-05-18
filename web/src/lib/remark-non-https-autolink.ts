/**
 * Remark plugin that converts raw non-https URI scheme text into link nodes.
 *
 * GFM (`remark-gfm`) already handles `http://`, `https://`, and `www.` autolinks.
 * This plugin handles the remainder: any `scheme://...` pattern where the scheme
 * is NOT `http` or `https` (to avoid duplicating GFM's work).
 *
 * Pipeline position: before `remarkStripCjkAutolink`, before `remarkMath`.
 *
 * Security note: this plugin deliberately has NO scheme allowlist — it converts
 * every `scheme://` pattern it finds. The sanitize layer (`urlTransform`) and
 * the onClick layer (`classifyScheme`) handle blocking/confirmation downstream.
 * Keeping the plugin allowlist-free means new custom schemes work automatically
 * without touching this file.
 */

// Matches a non-http(s) URI of the form `scheme://...` where:
//   - scheme is one or more ASCII letters (a-z), digits, +, -, or .
//   - scheme is NOT "http" or "https" (those are GFM's domain)
//   - followed by "://" and a run of non-whitespace characters
//
// Trailing punctuation (.,!?;:) and closing brackets/parens are stripped
// by a post-match trim step so "See obsidian://x." doesn't include the ".".
const NON_HTTPS_URI_RE = /\b(?!https?:\/\/)([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/[^\s]*/g

// Characters that may be stripped from the end of a matched URI.
// `)` and `]` are only stripped when the URL body has no unmatched opening
// counterpart — this mirrors GFM autolink literal behaviour and keeps URIs
// like `obsidian://open?file=Note(1)` intact.
const TRAILING_PUNCT_CHARS = /[.,;!?:)>\]'"]/

/**
 * Strip trailing punctuation from a URI, but preserve `)` / `]` that close an
 * unmatched `(` / `[` inside the URL body.
 *
 * Examples:
 *   `obsidian://x.`              → stripped `obsidian://x`,  trailing `.`
 *   `obsidian://open?file=Note(1)` → stripped unchanged,       trailing ``
 *   `obsidian://x).`             → stripped `obsidian://x`,  trailing `).` (no `(` to balance)
 */
function stripTrailingPunct(uri: string): { stripped: string; trailing: string } {
    let stripped = uri
    let trailing = ''
    while (stripped.length > 0) {
        const last = stripped[stripped.length - 1]
        if (!TRAILING_PUNCT_CHARS.test(last)) break

        if (last === ')' || last === ']') {
            const open = last === ')' ? '(' : '['
            const inner = stripped.slice(0, -1)
            let opens = 0
            let closes = 0
            for (const ch of inner) {
                if (ch === open) opens++
                else if (ch === last) closes++
            }
            // If the inner URL already has more opens than closes, the trailing
            // closer balances an earlier opener and belongs to the URL.
            if (closes < opens) break
        }

        trailing = last + trailing
        stripped = stripped.slice(0, -1)
    }
    return { stripped, trailing }
}

interface MdastNode {
    type: string
    url?: string
    value?: string
    lang?: string
    children?: MdastNode[]
}

/**
 * Walk all text nodes inside paragraph-like containers and replace
 * `scheme://...` patterns with link nodes.
 *
 * Skips:
 *   - `code` (fenced code blocks) and `inlineCode` nodes — never touched.
 *   - `link` / `linkReference` nodes — their children are not re-processed
 *     (existing links are left as-is).
 */
function visitAndLinkify(node: MdastNode): void {
    if (!node.children) return

    const newChildren: MdastNode[] = []

    for (const child of node.children) {
        // Don't descend into existing links or code nodes.
        if (
            child.type === 'link'
            || child.type === 'linkReference'
            || child.type === 'inlineCode'
            || child.type === 'code'
        ) {
            newChildren.push(child)
            continue
        }

        if (child.type === 'text' && typeof child.value === 'string') {
            const segments = linkifyText(child.value)
            newChildren.push(...segments)
            continue
        }

        // Recurse into other container nodes (e.g. paragraph, blockquote, list items).
        visitAndLinkify(child)
        newChildren.push(child)
    }

    node.children = newChildren
}

/**
 * Split a raw text string around any `scheme://...` matches and return a
 * mixed array of text nodes and link nodes.
 */
function linkifyText(text: string): MdastNode[] {
    const result: MdastNode[] = []
    let lastIndex = 0

    // Reset the regex state (global flag carries state across calls).
    NON_HTTPS_URI_RE.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = NON_HTTPS_URI_RE.exec(text)) !== null) {
        const rawUri = match[0]
        const matchStart = match.index

        // Strip trailing punctuation characters from the URI, preserving
        // balanced ()/[].
        const { stripped, trailing } = stripTrailingPunct(rawUri)

        // Text before this match.
        if (matchStart > lastIndex) {
            result.push({ type: 'text', value: text.slice(lastIndex, matchStart) })
        }

        // The link node.
        result.push({
            type: 'link',
            url: stripped,
            children: [{ type: 'text', value: stripped }],
        })

        // Any stripped trailing punctuation becomes a plain text node.
        if (trailing) {
            result.push({ type: 'text', value: trailing })
        }

        lastIndex = matchStart + rawUri.length
    }

    // Remaining text after the last match.
    if (lastIndex < text.length) {
        result.push({ type: 'text', value: text.slice(lastIndex) })
    }

    // If no matches were found, return the original text node unchanged.
    if (result.length === 0) {
        result.push({ type: 'text', value: text })
    }

    return result
}

export default function remarkNonHttpsAutolink() {
    return (tree: MdastNode) => {
        visitAndLinkify(tree)
    }
}
