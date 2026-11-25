/**
 * Fail-closed policy for scheme-less markdown hrefs in chat.
 *
 * Product rule (#1452): never paint a clickable control that SPA-404s.
 * Prefer session file preview when the target looks like a workspace file;
 * known in-app routes stay navigable; everything else path-like is inert text.
 */

import { COMMON_FILE_EXTENSIONS } from '@/lib/remark-file-path-links'

export type MarkdownHrefDecision =
    | { action: 'navigate' }
    | { action: 'file'; path: string }
    | { action: 'inert' }

const STATIC_SPA_PATHS = new Set([
    '/',
    '/browse',
    '/share',
    '/sessions',
    '/settings',
    '/settings/general',
    '/settings/display',
    '/settings/chat',
    '/settings/voice',
    '/settings/voice/voices',
    '/settings/voice/advanced',
    '/settings/machines',
    '/settings/about',
    '/settings/storage',
    '/settings/usage',
])

// /sessions/<id> plus known children only (files | file | terminal).
const SESSION_SPA_PATH =
    /^\/sessions\/[^/]+(?:\/(?:files|file|terminal))?\/?$/

export function splitHrefMeta(href: string): { path: string; suffix: string } {
    const hashIdx = href.indexOf('#')
    const queryIdx = href.indexOf('?')
    let cut = -1
    if (hashIdx >= 0 && queryIdx >= 0) cut = Math.min(hashIdx, queryIdx)
    else if (hashIdx >= 0) cut = hashIdx
    else if (queryIdx >= 0) cut = queryIdx
    if (cut < 0) return { path: href, suffix: '' }
    return { path: href.slice(0, cut), suffix: href.slice(cut) }
}

function stripLineSuffix(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '')
}

function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value)
}

export function hasKnownFileExtension(value: string): boolean {
    const path = stripLineSuffix(value).toLowerCase()
    const dot = path.lastIndexOf('.')
    if (dot < 0 || dot === path.length - 1) return false
    const ext = path.slice(dot + 1)
    return COMMON_FILE_EXTENSIONS.has(ext)
}

export function isKnownSpaHref(
    href: string,
    options: { baseUrl?: string } = {}
): boolean {
    if (href.startsWith('#') || href.startsWith('?')) return true
    if (href.startsWith('//')) return false
    const { path: raw } = splitHrefMeta(href)
    const path = raw.replace(/\/+$/, '') || '/'
    const rawBase = options.baseUrl ?? (import.meta.env.BASE_URL as string | undefined) ?? '/'
    const base = rawBase === '/' ? '' : rawBase.replace(/\/+$/, '')
    const routePath =
        base && (path === base || path.startsWith(`${base}/`))
            ? path.slice(base.length) || '/'
            : path
    if (STATIC_SPA_PATHS.has(routePath)) return true
    return SESSION_SPA_PATH.test(routePath)
}

export function inferHomeDir(workspacePath: string): string | null {
    if (workspacePath === '/root' || workspacePath.startsWith('/root/')) return '/root'
    const posix = workspacePath.match(/^(\/(?:home|Users)\/[^/]+)/)
    if (posix) return posix[1]
    const win = workspacePath.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i)
    if (win) return win[1]
    return null
}

export function expandTildePath(path: string, workspacePath: string | null | undefined): string | null {
    if (path !== '~' && !path.startsWith('~/')) return null
    if (!workspacePath) return null
    const home = inferHomeDir(workspacePath)
    if (!home) return null
    if (path === '~') return home
    const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
    const rest = path.slice(2).replace(/\\/g, '/')
    if (sep === '\\') return `${home}\\${rest.replace(/\//g, '\\')}`
    return `${home}/${rest}`
}

/** Lexically resolve `.` / `..`; return null if `..` escapes above the root. */
export function resolveLexicalPath(absPath: string): string | null {
    const norm = absPath.replace(/\\/g, '/')
    const absolute = norm.startsWith('/')
    const drive = /^[A-Za-z]:/.exec(norm)
    const parts = norm.split('/')
    const out: string[] = []
    for (const part of parts) {
        if (part === '' || part === '.') continue
        if (drive && part === drive[0]) {
            out.push(part)
            continue
        }
        if (part === '..') {
            if (out.length === 0) return null
            // Do not pop a Windows drive root segment.
            if (out.length === 1 && /^[A-Za-z]:$/.test(out[0]!)) return null
            out.pop()
            continue
        }
        out.push(part)
    }
    if (absolute) return `/${out.join('/')}`
    if (drive) {
        const [root, ...rest] = out
        return rest.length === 0 ? `${root}\\` : `${root}\\${rest.join('\\')}`
    }
    return out.join('/')
}

export function isWithinWorkspace(absPath: string, workspacePath: string): boolean {
    const target = resolveLexicalPath(absPath)
    const root = resolveLexicalPath(workspacePath)
    if (!target || !root) return false
    const normTarget = target.replace(/\\/g, '/').replace(/\/+$/, '')
    const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
    // Windows filesystems are case-insensitive; compare folded when both sides
    // are drive-qualified so `c:\Users\…` matches `C:\Users\…`.
    const windows = isWindowsAbsolutePath(normTarget) && isWindowsAbsolutePath(normRoot)
    const comparableTarget = windows ? normTarget.toLowerCase() : normTarget
    const comparableRoot = windows ? normRoot.toLowerCase() : normRoot
    return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}/`)
}

function isRepoRelativeCandidate(path: string): boolean {
    if (path.includes('://')) return false
    if (path.startsWith('/') || path.startsWith('~/') || path === '~') return false
    if (path.startsWith('../') || path.includes('/../')) return false
    // Drive-qualified paths need workspace containment — never treat as relative.
    if (isWindowsAbsolutePath(path)) return false
    return hasKnownFileExtension(path)
}

function looksPathLike(path: string): boolean {
    if (!path) return false
    if (path === '~' || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../')) return true
    if (path.startsWith('/') || isWindowsAbsolutePath(path)) return true
    if (path.includes('/') || path.includes('\\')) return true
    return hasKnownFileExtension(path)
}

/**
 * Classify a scheme-less markdown href for the chat <A> renderer.
 *
 * @param workspacePath session metadata.path when available (enables ~/ expansion + containment)
 */
export function classifyNoSchemeHref(
    href: string,
    options: { workspacePath?: string | null } = {}
): MarkdownHrefDecision {
    const trimmed = href.trim()
    if (!trimmed) return { action: 'inert' }

    // Protocol-relative URLs keep browser navigation (existing policy).
    if (trimmed.startsWith('//')) return { action: 'navigate' }

    if (isKnownSpaHref(trimmed)) return { action: 'navigate' }

    const { path: rawPath } = splitHrefMeta(trimmed)
    // mdast→hast percent-encodes spaces etc.; compare against literal workspace.
    let decodedPath: string
    try {
        decodedPath = decodeURIComponent(rawPath)
    } catch {
        return { action: 'inert' }
    }
    const path = stripLineSuffix(decodedPath)
    const workspacePath = options.workspacePath ?? null

    if (isRepoRelativeCandidate(path)) {
        return { action: 'file', path }
    }

    // Absolute / tilde targets need workspace metadata so we can fail closed on
    // out-of-tree paths (remark deliberately does not rewrite POSIX abs).
    if (isWindowsAbsolutePath(path) && hasKnownFileExtension(path)) {
        if (!workspacePath || !isWithinWorkspace(path, workspacePath)) {
            return { action: 'inert' }
        }
        return { action: 'file', path }
    }

    if (path.startsWith('/') && hasKnownFileExtension(path)) {
        if (!workspacePath || !isWithinWorkspace(path, workspacePath)) {
            return { action: 'inert' }
        }
        return { action: 'file', path }
    }

    if (path.startsWith('~/') || path === '~') {
        if (!hasKnownFileExtension(path)) return { action: 'inert' }
        const expanded = expandTildePath(path, workspacePath)
        if (!expanded) return { action: 'inert' }
        if (!workspacePath || !isWithinWorkspace(expanded, workspacePath)) {
            return { action: 'inert' }
        }
        return { action: 'file', path: expanded }
    }

    if (looksPathLike(path)) return { action: 'inert' }

    // Non-path leftovers (rare bare tokens) — do not invent SPA routes.
    return { action: 'inert' }
}

/**
 * Resolve a relative href/src against the directory of the Markdown file that
 * contains it. Returns null for URLs, absolute/home paths, fragment-only hrefs,
 * paths that `..` out of the file's root, and absolute results outside the workspace.
 */
export function resolveMarkdownRelativePath(
    markdownFilePath: string,
    href: string,
    workspacePath: string | null
): string | null {
    const { path: rawPath } = splitHrefMeta(href.trim())
    if (!rawPath || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath) || /^[/\\~]/.test(rawPath)) return null
    let path: string
    try {
        path = decodeURIComponent(rawPath)
    } catch {
        return null
    }
    const dir = markdownFilePath.slice(0, Math.max(markdownFilePath.lastIndexOf('/'), markdownFilePath.lastIndexOf('\\')) + 1)
    const resolved = resolveLexicalPath(`${dir}${path}`)
    if (!resolved) return null
    if (resolved.startsWith('/') || isWindowsAbsolutePath(resolved)) {
        return workspacePath && isWithinWorkspace(resolved, workspacePath) ? resolved : null
    }
    return resolved
}
