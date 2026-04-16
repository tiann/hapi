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

// Common CJK / fullwidth punctuation that should never be part of a URL.
const TRAILING_CJK_PUNCT = /[，。、；：！？（）【】「」『』《》〈〉\u3000\uFF0C\uFF0E\uFF1B\uFF1A\uFF01\uFF1F\uFF08\uFF09]+$/

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
            const match = child.url.match(TRAILING_CJK_PUNCT)
            if (match) {
                const punct = match[0]

                // Strip punctuation from the URL
                child.url = child.url.slice(0, -punct.length)

                // Strip from the link's text child (auto-links have a single text child)
                const textChild = child.children?.[0]
                if (textChild?.type === 'text' && typeof textChild.value === 'string' && textChild.value.endsWith(punct)) {
                    textChild.value = textChild.value.slice(0, -punct.length)
                }

                // Insert the punctuation as a plain text node after the link
                const punctNode: MdastNode = { type: 'text', value: punct }
                node.children.splice(i + 1, 0, punctNode)
                // Skip the newly inserted node
                i++
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
