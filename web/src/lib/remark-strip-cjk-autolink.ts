/**
 * Remark plugin that strips CJK/fullwidth punctuation from the end of
 * auto-linked URLs.
 *
 * `remark-gfm` auto-links bare URLs but its boundary detection only
 * handles ASCII punctuation.  When a URL is followed by CJK punctuation
 * (e.g. `，`、`。`) without whitespace, the punctuation is swallowed
 * into the link.  This plugin walks the MDAST after GFM runs and moves
 * any trailing CJK punctuation out of the link node into a sibling text
 * node.
 */

// CJK / fullwidth sentence-ending punctuation that should never be part of a
// URL, optionally followed by closing brackets/parens (which on their own are
// valid URL characters but should be stripped when they trail sentence-enders).
const TRAILING_CJK_PUNCT = /(?:[，。、；：！？\u3000\uFF0E]+[）】」』》〉]*)$/

interface MdastNode {
    type: string
    url?: string
    value?: string
    children?: MdastNode[]
}

function visitLinks(node: MdastNode): void {
    if (!node.children) return

    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]

        if (child.type === 'link' && typeof child.url === 'string') {
            // Only process auto-linked URLs (where the link text matches the URL).
            // Explicit markdown links like [text](url) should not be modified.
            const textChild = child.children?.[0]
            const isAutolink = child.children?.length === 1
                && textChild?.type === 'text'
                && typeof textChild.value === 'string'
                && textChild.value === child.url

            if (isAutolink) {
                const match = child.url.match(TRAILING_CJK_PUNCT)
                if (match) {
                    const punct = match[0]

                    // Strip punctuation from the URL
                    child.url = child.url.slice(0, -punct.length)

                    // Strip from the link's text child
                    textChild!.value = textChild!.value!.slice(0, -punct.length)

                    // Insert the punctuation as a plain text node after the link
                    const punctNode: MdastNode = { type: 'text', value: punct }
                    node.children.splice(i + 1, 0, punctNode)
                    // Skip the newly inserted node
                    i++
                }
            }
        }

        // Recurse into children
        visitLinks(child)
    }
}

export default function remarkStripCjkAutolink() {
    return (tree: MdastNode) => {
        visitLinks(tree)
    }
}
