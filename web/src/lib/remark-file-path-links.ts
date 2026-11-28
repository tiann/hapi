const FILE_PATH_HREF_PREFIX = 'hapi-file:'
// Encoded Windows abs handoff: raw `C:\…` is URI-normalized to `%5C` before <A>,
// which breaks drive detection. Candidate scheme preserves the path through hast.
const FILE_PATH_CANDIDATE_HREF_PREFIX = 'hapi-file-candidate:'

const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\.\/|[A-Za-z0-9_.-]+\/)[^\s`"\'<>]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9]{1,12}|lock))(?::\d+(?::\d+)?)?/g

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])
// Extensions that autolink to the session file viewer. Kept intentionally
// allowlisted (not "any dotted word") to avoid turning prose like "Node.js" or
// domains into dead file links. Additions target formats agents actually cite
// when handing over work: diagram sources (mmd/puml), docs (rst/adoc/tex),
// tabular data (csv/tsv), config/schema (ini/conf/env/proto/graphql/prisma),
// and common languages not already covered. TLD-lookalikes (org/com/io/dev/co)
// are deliberately excluded so URLs like "example.org" don't autolink.
export const COMMON_FILE_EXTENSIONS = new Set([
    'adoc', 'astro', 'avif', 'bat', 'bmp', 'c', 'cfg', 'cjs', 'conf', 'cpp', 'css', 'csv',
    'env', 'gif', 'go', 'gql', 'gradle', 'graphql', 'h', 'hpp', 'html', 'ico', 'ini', 'java',
    'jpeg', 'jpg', 'js', 'json', 'jsx', 'kt', 'lock', 'md', 'mdx', 'mjs', 'mmd', 'php', 'png',
    'prisma', 'properties', 'proto', 'ps1', 'puml', 'py', 'rb', 'rs', 'rst', 'scss', 'sh',
    'sql', 'svelte', 'svg', 'swift', 'tex', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'vue', 'webp',
    'xml', 'yaml', 'yml', 'zsh'
])

type MarkdownNode = {
    type?: string
    value?: string
    url?: string
    title?: string | null
    children?: MarkdownNode[]
    data?: {
        hProperties?: Record<string, unknown>
    }
}

function createFileHref(path: string): string {
    return `${FILE_PATH_HREF_PREFIX}${encodeURIComponent(path)}`
}

export function decodeFilePathHref(href: string): string | null {
    if (!href.startsWith(FILE_PATH_HREF_PREFIX)) return null
    try {
        return decodeURIComponent(href.slice(FILE_PATH_HREF_PREFIX.length))
    } catch {
        return null
    }
}

export function decodeFilePathCandidateHref(href: string): string | null {
    // Decode scheme bypass spellings (`HAPI-FILE-CANDIDATE:`, percent-encoded)
    // before extracting the payload. Empty payload → null (caller fails closed).
    let value = href.trimStart()
    for (let i = 0; i < 2; i++) {
        try {
            const next = decodeURIComponent(value)
            if (next === value) break
            value = next
        } catch {
            break
        }
    }
    const match = /^hapi-file-candidate:(.*)$/i.exec(value)
    if (!match) return null
    const payload = match[1]
    if (!payload) return null
    try {
        // Payload may already be decoded by the loop above; retry is a no-op.
        return decodeURIComponent(payload)
    } catch {
        return payload
    }
}

function createFileCandidateHref(path: string): string {
    return `${FILE_PATH_CANDIDATE_HREF_PREFIX}${encodeURIComponent(path)}`
}

function splitTrailingPunctuation(value: string): { path: string; trailing: string } {
    let path = value
    let trailing = ''

    while (path.length > 0) {
        const last = path[path.length - 1]
        if (TRAILING_PUNCTUATION.has(last)) {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        if (last === ')' && path.split('(').length <= path.split(')').length) {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        if (last === ']' || last === '}') {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        break
    }

    return { path, trailing }
}

function stripLineSuffix(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '')
}

function hasKnownFileExtension(value: string): boolean {
    const path = stripLineSuffix(value).toLowerCase()
    const ext = path.slice(path.lastIndexOf('.') + 1)
    return COMMON_FILE_EXTENSIONS.has(ext)
}

function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value)
}

function shouldLinkPath(value: string): boolean {
    if (value.includes('://')) return false
    const path = stripLineSuffix(value)
    if (path.length < 3) return false
    if (path.startsWith('/') || path.startsWith('~/')) return false
    if (path.startsWith('../') || path.includes('/../')) return false
    // Windows abs: autolink with the raw path (not hapi-file:) so <A> can
    // apply workspace containment before painting FilePathAnchor.
    if (isWindowsAbsolutePath(path)) return hasKnownFileExtension(path)
    if (path.includes('/')) return hasKnownFileExtension(path)
    return hasKnownFileExtension(path)
}

/** Autolink href: Windows abs uses candidate encoding so backslashes survive hast. */
function createAutolinkHref(filePath: string): string {
    if (isWindowsAbsolutePath(filePath)) return createFileCandidateHref(filePath)
    return createFileHref(filePath)
}

function linkTextNode(node: MarkdownNode): MarkdownNode[] {
    const value = node.value ?? ''
    const parts: MarkdownNode[] = []
    let lastIndex = 0

    PATH_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_PATTERN.exec(value)) !== null) {
        const rawMatch = match[0]
        const previousChar = match.index > 0 ? value[match.index - 1] : ''
        if (previousChar === ':' || previousChar === '/' || previousChar === '\\' || previousChar === '.') {
            continue
        }
        const { path: displayPath, trailing } = splitTrailingPunctuation(rawMatch)
        const filePath = stripLineSuffix(displayPath)

        if (!shouldLinkPath(filePath)) {
            continue
        }

        if (match.index > lastIndex) {
            parts.push({ type: 'text', value: value.slice(lastIndex, match.index) })
        }
        parts.push({
            type: 'link',
            url: createAutolinkHref(filePath),
            title: null,
            children: [{ type: 'text', value: displayPath }]
        })
        if (trailing) {
            parts.push({ type: 'text', value: trailing })
        }
        lastIndex = match.index + rawMatch.length
    }

    if (parts.length === 0) return [node]
    if (lastIndex < value.length) {
        parts.push({ type: 'text', value: value.slice(lastIndex) })
    }
    return parts
}

// Convert an `inlineCode` node whose ENTIRE value is a single linkable file
// path into a link wrapping an inlineCode (preserving monospace styling).
//
// Intentionally conservative: only whole-value, whitespace-free values that the
// path pattern matches end-to-end are linked. This keeps real code snippets
// (`npm run build`, `str.split()`, `Math.PI`, `a.b.c`) untouched — they either
// contain whitespace, non-path characters, or a non-allowlisted extension.
function linkInlineCodeNode(node: MarkdownNode): MarkdownNode | null {
    const raw = node.value ?? ''
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (/\s/.test(trimmed)) return null

    PATH_PATTERN.lastIndex = 0
    const match = PATH_PATTERN.exec(trimmed)
    // Require the pattern to cover the whole value — rejects `a=b.js`, `x.md#y`, etc.
    if (!match || match[0] !== trimmed) return null

    const filePath = stripLineSuffix(trimmed)
    if (!shouldLinkPath(filePath)) return null

    return {
        type: 'link',
        url: createAutolinkHref(filePath),
        title: null,
        children: [{ type: 'inlineCode', value: trimmed }]
    }
}

// Rewrite an explicit markdown link `[label](…file.ext)` into a `hapi-file:` href
// so it opens the session file viewer instead of dead-ending in the SPA router.
//
// Accepts:
// - repo-relative allowlisted paths (including `./` and `#fragment` / `:line` stripped)
//
// Still rejects: POSIX/Windows abs / `~/` (need session cwd — handled fail-closed in <A>),
// `../`, scheme-bearing URLs, and non-file targets (`/settings`, `#section`).
function rewriteFileLinkNode(node: MarkdownNode): void {
    if (node.type !== 'link') return
    const url = node.url
    if (!url) return
    if (url.startsWith(FILE_PATH_HREF_PREFIX)) return

    // Strip #fragment / ?query so `file.md#section` can still rewrite.
    const hashIdx = url.indexOf('#')
    const queryIdx = url.indexOf('?')
    let cut = -1
    if (hashIdx >= 0 && queryIdx >= 0) cut = Math.min(hashIdx, queryIdx)
    else if (hashIdx >= 0) cut = hashIdx
    else if (queryIdx >= 0) cut = queryIdx
    const withoutMeta = cut >= 0 ? url.slice(0, cut) : url

    const target = stripLineSuffix(withoutMeta)

    // Absolute paths (POSIX or Windows) need chat workspace metadata for
    // containment — leave POSIX for <A>; encode Windows as candidate so
    // backslashes survive mdast→hast URI normalization.
    if (isWindowsAbsolutePath(target)) {
        if (!hasKnownFileExtension(target)) return
        node.data = {
            ...node.data,
            hProperties: {
                ...node.data?.hProperties,
                'data-hapi-markdown-href': url,
            },
        }
        node.url = createFileCandidateHref(target)
        return
    }
    if (target.startsWith('/') && !target.startsWith('//')) return
    if (target.includes(':')) return

    if (!shouldLinkPath(target)) return

    node.data = {
        ...node.data,
        hProperties: {
            ...node.data?.hProperties,
            'data-hapi-markdown-href': url,
        },
    }
    node.url = createFileHref(target)
}

export type RemarkFilePathLinksOptions = {
    // Rewrite explicit markdown links `[label](relative/file.ext)` → `hapi-file:`.
    // Routing a `hapi-file:` href needs session context (FilePathAnchor); surfaces
    // that render without HappyChatContext (standalone file-preview) must disable
    // this or the anchor collapses to plain text (`A` returns props.children when
    // `!chat`). Bare-path / inlineCode autolinks are unaffected — they were already
    // plain text on those surfaces. Default: true (chat surface).
    rewriteExplicitLinks?: boolean
}

function visit(
    node: MarkdownNode,
    parentType: string | null,
    rewriteExplicitLinks: boolean
): void {
    if (!node.children) return
    if (parentType === 'link' || parentType === 'linkReference') return

    const nextChildren: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'text') {
            nextChildren.push(...linkTextNode(child))
            continue
        }
        if (child.type === 'inlineCode') {
            nextChildren.push(linkInlineCodeNode(child) ?? child)
            continue
        }
        if (child.type === 'link') {
            if (rewriteExplicitLinks) rewriteFileLinkNode(child)
            nextChildren.push(child)
            continue
        }
        visit(child, child.type ?? null, rewriteExplicitLinks)
        nextChildren.push(child)
    }
    node.children = nextChildren
}

export function remarkFilePathLinks(options: RemarkFilePathLinksOptions = {}) {
    const rewriteExplicitLinks = options.rewriteExplicitLinks !== false
    return (tree: MarkdownNode) => visit(tree, null, rewriteExplicitLinks)
}
