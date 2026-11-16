import { resolveImageMimeType } from '@/lib/file-markdown-preview'
import { decodeBase64 } from '@/lib/utils'

/** Reads a workspace file and returns its base64 content, or null when it cannot be read. */
export type ReadWorkspaceFileBase64 = (path: string) => Promise<string | null>

export const MAX_INLINED_ASSETS = 64
export const MAX_INLINED_ASSET_BYTES = 12 * 1024 * 1024

const FONT_MIME_BY_EXTENSION: Record<string, string> = {
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject'
}

const STYLESHEET_EXTENSIONS = new Set(['css'])
const SCRIPT_EXTENSIONS = new Set(['js', 'mjs'])
const FONT_EXTENSIONS = new Set(Object.keys(FONT_MIME_BY_EXTENSION))

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

export function isHtmlFile(path: string): boolean {
    const ext = path.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase()
    return ext === 'html' || ext === 'htm'
}

function extensionOf(path: string): string {
    const name = path.split('/').pop() ?? ''
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Images and fonts only: other file types (JSON, keys, configs) are never read into the preview. */
function isInlinableMediaAsset(path: string): boolean {
    return resolveImageMimeType(path) !== null || FONT_EXTENSIONS.has(extensionOf(path))
}

function resolveMimeType(path: string): string {
    return resolveImageMimeType(path) ?? FONT_MIME_BY_EXTENSION[extensionOf(path)] ?? 'application/octet-stream'
}

/**
 * Resolves a relative URL found in `fromFilePath` to a workspace path.
 * Only the directory subtree of `rootFilePath` (the previewed HTML file,
 * which contains `fromFilePath`) is reachable: returns null for
 * absolute/protocol URLs, root-relative paths, fragments, paths that climb
 * above that directory, and hidden (dot) files or directories such as `.env`
 * or `.git/`.
 */
export function resolveRelativeAssetPath(fromFilePath: string, ref: string, rootFilePath = fromFilePath): string | null {
    const trimmed = ref.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        return null
    }
    let pathPart = trimmed.split(/[?#]/, 1)[0] ?? ''
    try {
        pathPart = decodeURI(pathPart)
    } catch {
        // keep the raw value
    }
    if (!pathPart) return null

    const absoluteBase = fromFilePath.startsWith('/')
    const segments = fromFilePath.split('/').slice(0, -1).filter((segment) => segment !== '')
    const baseDepth = rootFilePath.split('/').slice(0, -1).filter((segment) => segment !== '').length
    for (const segment of pathPart.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
            if (segments.length <= baseDepth) return null
            segments.pop()
            continue
        }
        if (segment.startsWith('.')) return null
        segments.push(segment)
    }
    if (segments.length === baseDepth) return null
    return `${absoluteBase ? '/' : ''}${segments.join('/')}`
}

/** Lists a workspace directory's entries, or null when it cannot be listed. */
export type ListWorkspaceDirectory = (path: string) => Promise<Array<{ name: string; type: string }> | null>

/**
 * Wraps `readFile` so it refuses any asset whose path below the HTML file's
 * directory goes through a symlink. The file read API only checks that the
 * real path stays inside the workspace, so a link such as `style.css -> ../.env`
 * would otherwise bypass the preview's directory, dot-file and type limits.
 * Directory listings report symlinks as type `other`; every component must be
 * a plain `directory` (or `file` for the last one).
 */
export function withoutSymlinkedAssets(
    readFile: ReadWorkspaceFileBase64,
    listDirectory: ListWorkspaceDirectory,
    htmlPath: string
): ReadWorkspaceFileBase64 {
    const rootDir = htmlPath.split('/').slice(0, -1).join('/')
    const listings = new Map<string, Promise<Array<{ name: string; type: string }> | null>>()
    const list = (dir: string) => {
        let pending = listings.get(dir)
        if (!pending) {
            pending = listDirectory(dir).catch(() => null)
            listings.set(dir, pending)
        }
        return pending
    }
    return async (path) => {
        const prefix = rootDir ? `${rootDir}/` : ''
        if (!path.startsWith(prefix)) return null
        const components = path.slice(prefix.length).split('/')
        let dir = rootDir
        for (const [index, name] of components.entries()) {
            const entries = await list(dir)
            const expectedType = index === components.length - 1 ? 'file' : 'directory'
            if (!entries?.some((entry) => entry.name === name && entry.type === expectedType)) return null
            dir = dir ? `${dir}/${name}` : name
        }
        return await readFile(path)
    }
}

function collectCssUrlPaths(css: string, cssPath: string, htmlPath: string): string[] {
    const paths: string[] = []
    for (const match of css.matchAll(CSS_URL_PATTERN)) {
        const resolved = resolveRelativeAssetPath(cssPath, match[2] ?? '', htmlPath)
        if (resolved && isInlinableMediaAsset(resolved)) paths.push(resolved)
    }
    return paths
}

function rewriteCssUrls(css: string, cssPath: string, htmlPath: string, dataUrls: ReadonlyMap<string, string>): string {
    return css.replace(CSS_URL_PATTERN, (whole, _quote: string, ref: string) => {
        const resolved = resolveRelativeAssetPath(cssPath, ref, htmlPath)
        const dataUrl = resolved ? dataUrls.get(resolved) : undefined
        return dataUrl ? `url("${dataUrl}")` : whole
    })
}

/**
 * Makes a workspace HTML file self-contained for an `iframe srcdoc` preview:
 * local stylesheets are inlined, and local scripts, images, fonts and other
 * `url()` assets become data URLs. Assets beyond the count/byte budget
 * (in document order) are left untouched.
 */
export async function inlineHtmlAssets(
    html: string,
    htmlPath: string,
    readFile: ReadWorkspaceFileBase64
): Promise<string> {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    let remainingAssets = MAX_INLINED_ASSETS
    let remainingBytes = MAX_INLINED_ASSET_BYTES
    const readCache = new Map<string, Promise<string | null>>()

    const readWithinBudget = async (paths: string[]): Promise<Map<string, string>> => {
        const unique = [...new Set(paths)].slice(0, Math.max(0, remainingAssets))
        remainingAssets -= unique.length
        const contents = await Promise.all(unique.map((path) => {
            let pending = readCache.get(path)
            if (!pending) {
                pending = readFile(path).catch(() => null)
                readCache.set(path, pending)
            }
            return pending
        }))
        const result = new Map<string, string>()
        unique.forEach((path, index) => {
            const base64 = contents[index]
            if (!base64 || base64.length > remainingBytes) return
            remainingBytes -= base64.length
            result.set(path, base64)
        })
        return result
    }

    const decodeText = (base64: string): string | null => {
        const decoded = decodeBase64(base64)
        return decoded.ok ? decoded.text : null
    }

    // 1. Stylesheets and scripts, as text.
    const stylesheetLinks = [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]')]
        .map((element) => ({ element, path: resolveRelativeAssetPath(htmlPath, element.getAttribute('href') ?? '') }))
        .filter((entry): entry is { element: HTMLLinkElement; path: string } => (
            entry.path !== null && STYLESHEET_EXTENSIONS.has(extensionOf(entry.path))
        ))
    const scripts = [...doc.querySelectorAll<HTMLScriptElement>('script[src]')]
        .map((element) => ({ element, path: resolveRelativeAssetPath(htmlPath, element.getAttribute('src') ?? '') }))
        .filter((entry): entry is { element: HTMLScriptElement; path: string } => (
            entry.path !== null && SCRIPT_EXTENSIONS.has(extensionOf(entry.path))
        ))
    const textAssets = await readWithinBudget([
        ...stylesheetLinks.map((entry) => entry.path),
        ...scripts.map((entry) => entry.path)
    ])

    const inlinedStylesheets: Array<{ element: HTMLStyleElement; css: string; basePath: string }> = []
    for (const { element, path } of stylesheetLinks) {
        const base64 = textAssets.get(path)
        const css = base64 ? decodeText(base64) : null
        if (css === null) continue
        const style = doc.createElement('style')
        const media = element.getAttribute('media')
        if (media) style.setAttribute('media', media)
        element.replaceWith(style)
        inlinedStylesheets.push({ element: style, css, basePath: path })
    }
    for (const { element, path } of scripts) {
        const base64 = textAssets.get(path)
        if (!base64) continue
        // Stay an external script (data URL) so defer/async scheduling is preserved.
        element.setAttribute('src', `data:text/javascript;base64,${base64}`)
    }

    // 2. Binary assets referenced from markup and CSS, as data URLs.
    const styleBlocks = [
        ...inlinedStylesheets,
        ...[...doc.querySelectorAll<HTMLStyleElement>('style')]
            .filter((element) => !inlinedStylesheets.some((entry) => entry.element === element))
            .map((element) => ({ element, css: element.textContent ?? '', basePath: htmlPath }))
    ]
    const styledElements = [...doc.querySelectorAll<HTMLElement>('[style]')]
    const mediaAttributes: Array<{ element: Element; attribute: string; path: string }> = []
    const mediaSelectors: Array<[string, string]> = [
        ['img[src]', 'src'],
        ['source[src]', 'src'],
        ['video[poster]', 'poster'],
        ['input[type="image" i][src]', 'src'],
        ['link[rel~="icon" i][href]', 'href']
    ]
    for (const [selector, attribute] of mediaSelectors) {
        for (const element of doc.querySelectorAll(selector)) {
            const path = resolveRelativeAssetPath(htmlPath, element.getAttribute(attribute) ?? '')
            if (path && isInlinableMediaAsset(path)) mediaAttributes.push({ element, attribute, path })
        }
    }

    const binaryAssets = await readWithinBudget([
        ...mediaAttributes.map((entry) => entry.path),
        ...styleBlocks.flatMap((entry) => collectCssUrlPaths(entry.css, entry.basePath, htmlPath)),
        ...styledElements.flatMap((element) => collectCssUrlPaths(element.getAttribute('style') ?? '', htmlPath, htmlPath))
    ])
    const dataUrls = new Map<string, string>()
    for (const [path, base64] of binaryAssets) {
        dataUrls.set(path, `data:${resolveMimeType(path)};base64,${base64}`)
    }

    for (const { element, attribute, path } of mediaAttributes) {
        const dataUrl = dataUrls.get(path)
        if (!dataUrl) continue
        element.setAttribute(attribute, dataUrl)
        // A relative srcset would win over the inlined src and fail to load.
        if (attribute === 'src') element.removeAttribute('srcset')
    }
    for (const { element, css, basePath } of styleBlocks) {
        element.textContent = rewriteCssUrls(css, basePath, htmlPath, dataUrls)
    }
    for (const element of styledElements) {
        element.setAttribute('style', rewriteCssUrls(element.getAttribute('style') ?? '', htmlPath, htmlPath, dataUrls))
    }

    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : ''
    return `${doctype}${doc.documentElement.outerHTML}`
}
