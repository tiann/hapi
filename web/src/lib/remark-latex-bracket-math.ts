import type { Processor } from 'unified'
import { repairMarkdownTables } from './remark-repair-tables'

interface MarkdownNode {
    type: string
    value?: string
    children?: MarkdownNode[]
    data?: unknown
    position?: {
        start: { offset?: number }
        end: { offset?: number }
    }
    referenceType?: string
}

interface MarkdownFile {
    value?: unknown
}

type MathKind = 'display' | 'inline'

const OPAQUE_NODE_TYPES = new Set([
    'code',
    'inlineCode',
    'math',
    'inlineMath',
    'link',
    'linkReference',
    'html',
])

const SOURCE_OPAQUE_NODE_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])

function isUnescapedDelimiter(source: string, offset: number): boolean {
    // An odd run of backslashes before the delimiter escapes the final
    // backslash. An even run leaves the delimiter backslash unescaped, which
    // also keeps a TeX line break immediately before `\\]` usable.
    let precedingBackslashes = 0
    for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--) {
        precedingBackslashes++
    }
    return precedingBackslashes % 2 === 0
}

interface BracketMathMatch {
    continuationPrefix: string
    end: number
    kind: MathKind
    start: number
    value: string
}

type ProtectedMask = boolean[]

interface BracketMathPlaceholder extends BracketMathMatch {
    placeholder: string
    raw: string
    token: string
}

type PlaceholderMap = Map<string, BracketMathPlaceholder>

function markProtectedRange(mask: ProtectedMask, start: number, end: number): void {
    for (let index = start; index < end; index++) mask[index] = true
}

function containsProtectedRange(mask: ProtectedMask, start: number, end: number): boolean {
    for (let index = start; index < end; index++) {
        if (mask[index]) return true
    }
    return false
}

function getNodeOffsets(node: MarkdownNode): { end: number; start: number } | null {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (typeof start !== 'number' || typeof end !== 'number') return null
    if (start < 0 || end < start) return null
    return { end, start }
}

function findClosingMarkdownBracket(source: string, start: number, end: number): number | null {
    let depth = 0
    for (let index = start; index < end; index++) {
        if (source[index] === '\\') {
            index++
            continue
        }
        if (source[index] === '[') {
            depth++
        } else if (source[index] === ']') {
            depth--
            if (depth === 0) return index
        }
    }
    return null
}

function markMarkdownMetadataRanges(source: string, node: MarkdownNode, mask: ProtectedMask): void {
    const offsets = getNodeOffsets(node)
    if (offsets && SOURCE_OPAQUE_NODE_TYPES.has(node.type)) {
        markProtectedRange(mask, offsets.start, offsets.end)
    }

    if (offsets && (node.type === 'link' || node.type === 'image' || node.type === 'definition')) {
        const labelStart = offsets.start + (node.type === 'image' ? 1 : 0)
        const labelEnd = findClosingMarkdownBracket(source, labelStart, offsets.end)
        if (labelEnd !== null) {
            const separator = source[labelEnd + 1]
            if (node.type === 'image') {
                // Image alt text is metadata, not rendered Markdown content.
                markProtectedRange(mask, labelStart, labelEnd + 1)
            }
            if (node.type === 'definition') {
                // Reference identifiers are metadata, not rendered Markdown
                // content. Protect the identifier and its destination.
                markProtectedRange(mask, labelStart, labelEnd + 1)
            }
            if (node.type === 'definition' && separator === ':') {
                markProtectedRange(mask, labelEnd + 1, offsets.end)
            } else if ((node.type === 'link' || node.type === 'image') && separator === '(') {
                // Link destinations and titles are metadata, not message text.
                // Protect them while still allowing math in the link label.
                markProtectedRange(mask, labelEnd + 1, offsets.end)
            }
        }
    }

    if (offsets && (node.type === 'linkReference' || node.type === 'imageReference')) {
        const labelStart = offsets.start + (node.type === 'imageReference' ? 1 : 0)
        const labelEnd = findClosingMarkdownBracket(source, labelStart, offsets.end)
        if (labelEnd !== null) {
            if (node.type === 'imageReference' || node.referenceType !== 'full') {
                // Image alt text and shortcut/collapsed link labels are also
                // reference metadata, so their spelling must remain intact.
                markProtectedRange(mask, labelStart, labelEnd + 1)
            }

            const referenceStart = labelEnd + 1
            if (source[referenceStart] === '[') {
                const referenceEnd = findClosingMarkdownBracket(source, referenceStart, offsets.end)
                if (referenceEnd !== null) markProtectedRange(mask, referenceStart, referenceEnd + 1)
            }
        }
    }

    for (const child of node.children ?? []) {
        markMarkdownMetadataRanges(source, child, mask)
    }
}

function getProtectedMarkdownRanges(source: string, tree: MarkdownNode): ProtectedMask {
    const mask = Array<boolean>(source.length).fill(false)
    markMarkdownMetadataRanges(source, tree, mask)

    return mask
}

function isProtected(mask: ProtectedMask, start: number, length: number): boolean {
    for (let index = start; index < start + length; index++) {
        if (mask[index]) return true
    }
    return false
}

function findNextDelimiter(source: string, delimiter: string, from: number, mask: ProtectedMask): number {
    let offset = source.indexOf(delimiter, from)
    while (offset >= 0 && (isProtected(mask, offset, delimiter.length) || !isUnescapedDelimiter(source, offset))) {
        offset = source.indexOf(delimiter, offset + 1)
    }
    return offset
}

function findClosingDelimiter(source: string, delimiter: string, from: number, mask: ProtectedMask): number {
    const offset = findNextDelimiter(source, delimiter, from, mask)
    return offset >= 0 && !containsProtectedRange(mask, from, offset) ? offset : -1
}

function getMarkdownContainerPrefix(source: string, offset: number): string {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1
    const beforeDelimiter = source.slice(lineStart, offset)
    let cursor = 0
    let continuationPrefix = ''
    let recognizedContainer = false

    while (cursor < beforeDelimiter.length) {
        const containerStart = cursor
        while (cursor < beforeDelimiter.length && (beforeDelimiter[cursor] === ' ' || beforeDelimiter[cursor] === '\t')) cursor++
        if (cursor - containerStart > 3) {
            cursor = containerStart
            break
        }

        if (beforeDelimiter[cursor] === '>') {
            cursor++
            if (beforeDelimiter[cursor] === ' ' || beforeDelimiter[cursor] === '\t') cursor++
            continuationPrefix += beforeDelimiter.slice(containerStart, cursor)
            recognizedContainer = true
            continue
        }

        const listMarker = beforeDelimiter.slice(cursor).match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+/u)
        if (listMarker) {
            continuationPrefix += ' '.repeat(cursor - containerStart + listMarker[0].length)
            cursor += listMarker[0].length
            recognizedContainer = true
            continue
        }

        cursor = containerStart
        break
    }

    if (!recognizedContainer && beforeDelimiter.trim().length > 0) {
        return ''
    }

    return continuationPrefix || beforeDelimiter
}

function stripLinePrefix(value: string, prefix: string): string {
    if (!prefix) return value

    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return value.replace(new RegExp(`(\\r?\\n)${escapedPrefix}`, 'gu'), '$1')
}

function findBracketMathMatches(source: string, mask: ProtectedMask): BracketMathMatch[] {
    const matches: BracketMathMatch[] = []
    let cursor = 0

    while (cursor < source.length) {
        const displayStart = findNextDelimiter(source, '\\[', cursor, mask)
        const inlineStart = findNextDelimiter(source, '\\(', cursor, mask)

        let start = -1
        let kind: MathKind | null = null
        if (displayStart >= 0 && (inlineStart < 0 || displayStart < inlineStart)) {
            start = displayStart
            kind = 'display'
        } else if (inlineStart >= 0) {
            start = inlineStart
            kind = 'inline'
        }

        if (start < 0 || kind === null) break

        const openingLength = 2
        const closingDelimiter = kind === 'display' ? '\\]' : '\\)'
        const closingStart = findClosingDelimiter(source, closingDelimiter, start + openingLength, mask)
        if (closingStart < 0) {
            cursor = start + openingLength
            continue
        }

        const continuationPrefix = getMarkdownContainerPrefix(source, start)
        const value = stripLinePrefix(
            source.slice(start + openingLength, closingStart),
            continuationPrefix
        ).trim()
        if (value.length > 0) {
            matches.push({
                continuationPrefix,
                end: closingStart + closingDelimiter.length,
                kind,
                start,
                value,
            })
            cursor = closingStart + closingDelimiter.length
        } else {
            cursor = closingStart + closingDelimiter.length
        }
    }

    return matches
}

function createMathNode(kind: MathKind, value: string): MarkdownNode {
    if (kind === 'display') {
        return {
            type: 'math',
            value,
            data: {
                hName: 'pre',
                hChildren: [{
                    type: 'element',
                    tagName: 'code',
                    properties: { className: ['language-math', 'math-display'] },
                    children: [{ type: 'text', value }],
                }],
            },
        }
    }

    return {
        type: 'inlineMath',
        value,
        data: {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-inline'] },
            hChildren: [{ type: 'text', value }],
        },
    }
}

function findUnusedPlaceholderToken(source: string, start: number): string {
    for (let codePoint = start; codePoint <= 0xF8FF; codePoint++) {
        const token = String.fromCharCode(codePoint)
        if (!source.includes(token)) return token
    }
    throw new Error('Unable to allocate a LaTeX placeholder token')
}

function replaceLineContentWithToken(line: string, prefix: string, token: string): string {
    return prefix + token.repeat(Math.max(1, line.length - prefix.length))
}

function makePlaceholder(value: string, token: string): string {
    const parts = value.split(/(\r?\n)/)
    return parts.map((part) => {
        if (/^\r?\n$/u.test(part)) return part
        return replaceLineContentWithToken(part, '', token)
    }).join('')
}

function makeSourcePlaceholder(source: string, match: BracketMathMatch, token: string): string {
    const raw = source.slice(match.start, match.end)
    const parts = raw.split(/(\r?\n)/)
    return parts.map((part, index) => {
        if (/^\r?\n$/.test(part)) return part
        if (index === 0) return token.repeat(part.length)

        // Preserve the quote prefix that was present on the formula's opening
        // line so the reparsed source stays inside the original blockquote.
        const prefix = match.continuationPrefix && part.startsWith(match.continuationPrefix)
            ? match.continuationPrefix
            : ''
        return replaceLineContentWithToken(part, prefix, token)
    }).join('')
}

function prepareBracketMathSource(source: string, tree: MarkdownNode): { source: string; placeholders: PlaceholderMap } | null {
    const matches = findBracketMathMatches(source, getProtectedMarkdownRanges(source, tree))
    if (matches.length === 0) return null

    const placeholders: PlaceholderMap = new Map()
    const chunks: string[] = []
    let cursor = 0
    let nextToken = 0xE000
    for (const match of matches) {
        const token = findUnusedPlaceholderToken(source, nextToken)
        nextToken = token.charCodeAt(0) + 1
        const raw = source.slice(match.start, match.end)
        const sourcePlaceholder = makeSourcePlaceholder(source, match, token)
        const placeholder = makePlaceholder(
            stripLinePrefix(sourcePlaceholder, match.continuationPrefix),
            token
        )
        placeholders.set(token, { ...match, placeholder, raw, token })
        chunks.push(source.slice(cursor, match.start), sourcePlaceholder)
        cursor = match.end
    }
    chunks.push(source.slice(cursor))

    return { source: chunks.join(''), placeholders }
}

function matchesPlaceholderAt(value: string, offset: number, placeholder: string): number | null {
    let valueOffset = offset
    for (let placeholderOffset = 0; placeholderOffset < placeholder.length; placeholderOffset++) {
        const character = placeholder[placeholderOffset]
        if (character === '\r' && placeholder[placeholderOffset + 1] === '\n') continue
        if (character === '\n') {
            if (value[valueOffset] === '\r') valueOffset++
            if (value[valueOffset] !== '\n') return null
        } else if (value[valueOffset] !== character) {
            return null
        }
        valueOffset++
    }
    return valueOffset
}

function findNextPlaceholder(value: string, from: number, placeholders: PlaceholderMap): {
    end: number
    entry: BracketMathPlaceholder
    start: number
} | null {
    for (let offset = from; offset < value.length; offset++) {
        const entry = placeholders.get(value[offset])
        if (!entry) continue
        const end = matchesPlaceholderAt(value, offset, entry.placeholder)
        if (end !== null) return { end, entry, start: offset }
    }
    return null
}

function restorePlaceholders(value: string, placeholders: PlaceholderMap): string {
    const parts: string[] = []
    let cursor = 0
    while (true) {
        const next = findNextPlaceholder(value, cursor, placeholders)
        if (!next) {
            parts.push(value.slice(cursor))
            return parts.join('')
        }
        parts.push(value.slice(cursor, next.start), next.entry.raw)
        cursor = next.end
    }
}

function splitTextNode(node: MarkdownNode, placeholders: PlaceholderMap): MarkdownNode[] {
    const value = node.value
    if (typeof value !== 'string') return [node]

    const children: MarkdownNode[] = []
    let cursor = 0
    let found = false
    while (true) {
        const next = findNextPlaceholder(value, cursor, placeholders)
        if (!next) break
        found = true
        if (next.start > cursor) children.push({ type: 'text', value: value.slice(cursor, next.start) })
        children.push(createMathNode(next.entry.kind, next.entry.value))
        cursor = next.end
    }
    if (!found) return [node]
    if (cursor < value.length) children.push({ type: 'text', value: value.slice(cursor) })
    return children
}

function splitParagraphAroundDisplayMath(node: MarkdownNode): MarkdownNode[] | null {
    const children = node.children ?? []
    if (!children.some((child) => child.type === 'math')) return null

    const blocks: MarkdownNode[] = []
    let paragraphChildren: MarkdownNode[] = []

    const flushParagraph = () => {
        const hasContent = paragraphChildren.some((child) => (
            child.type !== 'text' || (child.value ?? '').trim().length > 0
        ))
        if (hasContent) blocks.push({ type: 'paragraph', children: paragraphChildren })
        paragraphChildren = []
    }

    for (const child of children) {
        if (child.type === 'math') {
            flushParagraph()
            blocks.push(child)
        } else {
            paragraphChildren.push(child)
        }
    }
    flushParagraph()

    return blocks
}

function transformContainer(node: MarkdownNode, placeholders: PlaceholderMap): void {
    if (!node.children) return

    const children: MarkdownNode[] = []
    for (const child of node.children) {
        if (OPAQUE_NODE_TYPES.has(child.type)) {
            if (typeof child.value === 'string') {
                child.value = restorePlaceholders(child.value, placeholders)
            }
            if (child.children) restorePlaceholdersInContainer(child, placeholders)
            children.push(child)
            continue
        }

        if (child.type === 'text') {
            children.push(...splitTextNode(child, placeholders))
            continue
        }

        transformContainer(child, placeholders)
        const splitParagraph = child.type === 'paragraph'
            ? splitParagraphAroundDisplayMath(child)
            : null
        children.push(...(splitParagraph ?? [child]))
    }
    node.children = children
}

function restorePlaceholdersInContainer(node: MarkdownNode, placeholders: PlaceholderMap): void {
    if (!node.children) return
    for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
            child.value = restorePlaceholders(child.value, placeholders)
        } else {
            restorePlaceholdersInContainer(child, placeholders)
        }
    }
}

/** Convert TeX bracket delimiters before Markdown escape handling loses them. */
export default function remarkLatexBracketMath(this: Processor) {
    const processor = this
    return (tree: MarkdownNode, file: MarkdownFile): void => {
        if (typeof file.value !== 'string') return

        // Markdown parses `K^*` as emphasis and a line containing only `=` as
        // a setext heading before a normal transformer can inspect the source.
        // Replace each bracket-delimited formula with private-use tokens, parse
        // the safe source, then restore the formula as an AST math node. A
        // token on empty formula lines keeps Markdown from splitting a match.
        const source = repairMarkdownTables(file.value)
        const sourceTree = source === file.value
            ? tree
            : processor.parse(source) as MarkdownNode
        const prepared = prepareBracketMathSource(source, sourceTree)
        if (!prepared) return

        const reparsedTree = processor.parse(prepared.source) as MarkdownNode
        transformContainer(reparsedTree, prepared.placeholders)
        Object.assign(tree, reparsedTree)
    }
}
