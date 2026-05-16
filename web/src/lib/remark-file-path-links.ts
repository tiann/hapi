const FILE_PATH_HREF_PREFIX = 'hapi-file:'

const PATH_PATTERN = /(?:\.\/|[A-Za-z0-9_.-]+\/)[^\s`"\'<>]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9]{1,12}|lock))(?::\d+(?::\d+)?)?/g

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])
const COMMON_FILE_EXTENSIONS = new Set([
    'avif', 'bmp', 'c', 'cjs', 'cpp', 'css', 'gif', 'go', 'h', 'hpp', 'html', 'ico', 'java',
    'jpeg', 'jpg', 'js', 'json', 'jsx', 'kt', 'lock', 'md', 'mdx', 'mjs', 'png', 'py', 'rs',
    'scss', 'sh', 'sql', 'svg', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'webp', 'xml',
    'yaml', 'yml', 'zsh'
])

type MarkdownNode = {
    type?: string
    value?: string
    url?: string
    title?: string | null
    children?: MarkdownNode[]
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

function shouldLinkPath(value: string): boolean {
    if (value.includes('://')) return false
    const path = stripLineSuffix(value)
    if (path.length < 3) return false
    if (path.startsWith('/') || path.startsWith('~/')) return false
    if (path.startsWith('../') || path.includes('/../')) return false
    if (/^[A-Za-z]:[\\/]/.test(path)) return false
    if (path.includes('/')) return hasKnownFileExtension(path)
    return hasKnownFileExtension(path)
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
            url: createFileHref(filePath),
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

function visit(node: MarkdownNode, parentType: string | null = null): void {
    if (!node.children) return
    if (parentType === 'link' || parentType === 'linkReference') return

    const nextChildren: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'text') {
            nextChildren.push(...linkTextNode(child))
            continue
        }
        visit(child, child.type ?? null)
        nextChildren.push(child)
    }
    node.children = nextChildren
}

export function remarkFilePathLinks() {
    return (tree: MarkdownNode) => visit(tree)
}
