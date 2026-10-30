package app.hapi.protocol.markdown

import org.commonmark.node.CustomBlock
import org.commonmark.node.CustomNode

/** Whether a formula came from block-level or inline-level delimiters. */
enum class MathKind {
    /** `$$...$$` on its own lines or `\[...\]` — web `math` node, `math-display`. */
    DISPLAY,

    /** `\( ... \)` or `$$...$$` mid-paragraph — web `inlineMath` node, `math-inline`. */
    INLINE,
}

/**
 * Block-level display math extracted from the source by [MarkdownMath].
 *
 * Mirrors the web `math` mdast node produced by `remark-latex-bracket-math`
 * (`\[...\]`) and `remark-math` flow math (`$$...$$` on their own lines): both
 * end up as `pre > code.language-math.math-display`, rendered by rehype-katex
 * with `displayMode: true`.
 *
 * Extends [CustomBlock] so it can be hoisted to a top-level block sibling
 * (web `splitParagraphAroundDisplayMath` parity); before hoisting it may
 * transiently sit in inline position, where the Compose walker degrades it to
 * the monospace inline fallback instead.
 */
class MathBlockNode(val latex: String) : CustomBlock() {
    override fun toString(): String = "MathBlockNode(${latex.replace("\n", "\\n")})"
}

/**
 * Inline math extracted from `\( ... \)` or mid-paragraph `$$...$$`.
 *
 * Mirrors the web `inlineMath` mdast node (rendered by rehype-katex without
 * display mode). Produced by splitting [org.commonmark.node.Text] nodes that
 * contain a placeholder token, so it appears at any inline nesting depth
 * (emphasis, links labels excluded — those are protected at extraction time).
 */
class MathInlineNode(val latex: String) : CustomNode() {
    override fun toString(): String = "MathInlineNode(${latex.replace("\n", "\\n")})"
}
