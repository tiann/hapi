import '@assistant-ui/react-markdown/styles/dot.css'

import type { ComponentPropsWithoutRef, MouseEvent } from 'react'
import { useState, useCallback, useEffect, useMemo, createContext, useContext, type ReactNode } from 'react'
import {
    MarkdownTextPrimitive,
    unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
    useIsMarkdownCodeBlock,
    type CodeHeaderProps,
} from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkDisableIndentedCode from '@/lib/remark-disable-indented-code'
import { useNavigate } from '@tanstack/react-router'
import remarkStripCjkAutolink from '@/lib/remark-strip-cjk-autolink'
import remarkNonHttpsAutolink from '@/lib/remark-non-https-autolink'
import { cn, encodeBase64 } from '@/lib/utils'
import { SyntaxHighlighter } from '@/components/assistant-ui/shiki-highlighter'
import { MermaidDiagram } from '@/components/assistant-ui/mermaid-diagram'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { decodeFilePathHref, remarkFilePathLinks } from '@/lib/remark-file-path-links'
import { UriConfirmDialog } from '@/components/UriConfirmDialog'

import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'

// ── Plugin array ────────────────────────────────────────────────────────────
// Order: remarkGfm → remarkNonHttpsAutolink → remarkStripCjkAutolink → remarkMath → remarkDisableIndentedCode → remarkFilePathLinks
// remarkNonHttpsAutolink must run BEFORE remarkStripCjkAutolink so that the
// CJK strip plugin sees the new link nodes and can trim trailing CJK punctuation
// from them. Both must come before remarkMath (to avoid treating TeX as URI).
// remarkFilePathLinks runs last to convert file paths → links after all other
// transforms have settled.
export const MARKDOWN_PLUGINS = [
    remarkGfm,
    remarkNonHttpsAutolink,
    remarkStripCjkAutolink,
    remarkMath,
    remarkDisableIndentedCode,
    remarkFilePathLinks,        // upstream — file path → link conversion, runs last
] satisfies NonNullable<MarkdownTextPrimitiveProps['remarkPlugins']>

export const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex] satisfies NonNullable<MarkdownTextPrimitiveProps['rehypePlugins']>
export const MARKDOWN_CLASSNAME = 'aui-md happy-chat-text min-w-0 max-w-full break-words text-[var(--app-fg)]'
export const MARKDOWN_COMPONENTS_BY_LANGUAGE = {
    mermaid: {
        SyntaxHighlighter: MermaidDiagram,
    },
} satisfies NonNullable<MarkdownTextPrimitiveProps['componentsByLanguage']>

// ── URI scheme policy (inlined from url-scheme-policy.ts) ───────────────────
//
// IANA-registered safe schemes — mirrors react-markdown defaultUrlTransform exactly.
// Source: node_modules/react-markdown/lib/index.js:124  /^(https?|ircs?|mailto|xmpp)$/i
const IANA_SAFE_SCHEMES: ReadonlySet<string> = new Set([
    'http',
    'https',
    'irc',
    'ircs',
    'mailto',
    'xmpp',
])

// Schemes that must always be blocked regardless of user preference.
// Includes file: because Chromium denies navigation from http(s) origins.
const DENY_SCHEMES: ReadonlySet<string> = new Set([
    'javascript',
    'data',
    'vbscript',
    'file',
])

/**
 * Extract the normalised scheme from a URL string.
 *
 * Applies up to two rounds of decodeURIComponent so that double-encoded
 * bypass attempts (`javascript%253A` → `javascript%3A` → `javascript:`)
 * are unwrapped before the scheme is extracted.
 *
 * After decoding, ASCII control characters (U+0000–U+001F, U+007F) and
 * all whitespace are stripped from the extracted scheme string so that
 * browsers' built-in normalization — which silently discards \t, \n, \r
 * and space from scheme names during navigation — cannot be used to bypass
 * the deny list (e.g. `java\nscript:alert(1)` → scheme `"javascript"`).
 *
 * Returns null when no valid scheme separator is found.
 */
function normalizedScheme(url: string): string | null {
    let value = url.trimStart()
    for (let i = 0; i < 2; i++) {
        try {
            const next = decodeURIComponent(value)
            if (next === value) break
            value = next
        } catch {
            break
        }
    }
    const colonIndex = value.indexOf(':')
    if (colonIndex <= 0) return null
    // Strip ASCII control chars (U+0000–U+001F, DEL U+007F) and all whitespace
    // from the scheme name. Browsers strip exactly these characters during
    // navigation, so `java\nscript` navigates as `javascript`.
    return value.slice(0, colonIndex).replace(/[\x00-\x1F\x7F\s]/g, '').toLowerCase()
}

/**
 * Classify a URL string by its scheme.
 *
 * Uses normalizedScheme() so that common bypass patterns — control characters
 * spliced into the scheme name, tab/space prefix, single- and double-encoded
 * scheme characters — are all caught before the deny/IANA comparison.
 *
 * @returns 'iana' | 'deny' | 'custom'
 */
export function classifyScheme(url: string): 'iana' | 'deny' | 'custom' {
    const scheme = normalizedScheme(url)
    if (scheme === null) return 'deny'
    if (DENY_SCHEMES.has(scheme)) return 'deny'
    if (IANA_SAFE_SCHEMES.has(scheme)) return 'iana'
    return 'custom'
}

/**
 * Returns true when href contains a URL scheme (i.e. a "scheme:" prefix that
 * appears before any path/query/fragment delimiter).
 *
 * This distinguishes `mailto:foo@bar` (has scheme → true) from purely relative
 * hrefs like `/settings`, `./foo`, `#section`, `?q=1`, or paths that contain a
 * colon after a path segment like `/path:colon` (→ false, because `/` appears
 * before `:`). Protocol-relative URLs (`//host/path`) have no colon and are
 * also treated as scheme-less; browsers navigate them as the current origin's
 * protocol, same as a normal relative path would do.
 *
 * Used by <A> to short-circuit classifyScheme for no-scheme hrefs and treat them
 * as 'iana' so the browser/router can handle them normally (fixing the regression
 * where relative markdown links were silently blocked by the onClick deny guard).
 */
function hasScheme(href: string): boolean {
    const colonIdx = href.indexOf(':')
    if (colonIdx <= 0) return false
    const boundaryIdx = href.search(/[/?#]/)
    return boundaryIdx < 0 || colonIdx < boundaryIdx
}

// ── URL sanitize transform (deny-only) ──────────────────────────────────────
// Passed as urlTransform to MarkdownTextPrimitive. Only deny-listed schemes
// are stripped; every other scheme (IANA + custom) passes through so the
// <a href> is preserved for the onClick layer to handle.
//
// Uses classifyScheme as the single source of truth for scheme extraction so
// that percent-encoded bypass patterns (jav%61script:, %6Aavascript:) are
// caught by the same decoding logic used at click time.
//
// Relative paths (no colon, or colon only in path/query) have no scheme and
// are always passed through — they are safe and used for img src etc.
//
// Known limitation (FIX 5, deferred): data:image/png;base64,... used in
// <img src> is also stripped because DENY_SCHEMES includes 'data'. However,
// react-markdown's own defaultUrlTransform strips all data: URLs identically,
// so this is not a regression introduced by this PR.
export function denyOnlyTransform(url: string): string {
    if (!url) return url
    const trimmed = url.trimStart()
    const colonIdx = trimmed.indexOf(':')
    const slashIdx = trimmed.search(/[/?#]/)
    if (colonIdx < 0 || (slashIdx >= 0 && slashIdx < colonIdx)) {
        return url
    }
    return classifyScheme(url) === 'deny' ? '' : url
}

// ── Allowed-schemes state (inlined from useAllowedSchemes.ts) ───────────────

const STORAGE_KEY = 'hapi-allowed-schemes'

// Module-level subscriber set for intra-tab cross-provider sync (P7e.1).
//
// `window` `storage` events fire only in OTHER tabs/windows, not in the same
// tab that called setItem. When two <UriConfirmProvider>s exist in the same
// window (e.g. MarkdownText + Reasoning as sibling providers in AssistantMessage),
// clicking "Always allow" in one provider's dialog must immediately update the
// other without waiting for a page reload.
//
// Solution: a module-level Set of subscriber callbacks. writeAllowedToStorage
// calls each subscriber synchronously after writing to localStorage. Each
// useAllowedSchemes instance registers on mount and unregisters on unmount.
// Cross-tab sync continues to use the existing window `storage` event.
type SchemeListener = (schemes: ReadonlySet<string>) => void
const schemeListeners = new Set<SchemeListener>()

function readAllowedFromStorage(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return new Set()
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Set()
        return new Set(
            parsed
                .filter((s): s is string => typeof s === 'string')
                .filter((s) => !DENY_SCHEMES.has(s))
        )
    } catch {
        return new Set()
    }
}

function writeAllowedToStorage(schemes: ReadonlySet<string>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(schemes)))
    } catch {
        // Storage quota exceeded — silently ignore; in-memory set still works.
    }
    // Notify all same-tab subscribers synchronously so sibling providers
    // (e.g. MarkdownText + Reasoning) update in the same React event loop tick.
    for (const listener of schemeListeners) {
        listener(schemes)
    }
}

function useAllowedSchemes() {
    const [allowed, setAllowed] = useState<ReadonlySet<string>>(() => readAllowedFromStorage())

    useEffect(() => {
        // Cross-tab sync: storage event fires in other tabs/windows.
        function handleStorage(e: StorageEvent) {
            if (e.key !== STORAGE_KEY) return
            setAllowed(readAllowedFromStorage())
        }
        window.addEventListener('storage', handleStorage)

        // Intra-tab sync: subscribe to module-level emitter so sibling
        // providers in the same window see updates without page reload.
        function handleIntraTab(schemes: ReadonlySet<string>) {
            setAllowed(new Set(schemes))
        }
        schemeListeners.add(handleIntraTab)

        return () => {
            window.removeEventListener('storage', handleStorage)
            schemeListeners.delete(handleIntraTab)
        }
    }, [])

    const allow = useCallback((scheme: string) => {
        if (DENY_SCHEMES.has(scheme)) return
        setAllowed((prev) => {
            if (prev.has(scheme)) return prev
            const next = new Set(prev)
            next.add(scheme)
            writeAllowedToStorage(next)
            return next
        })
    }, [])

    const isAllowed = useCallback(
        (scheme: string): boolean => {
            if (DENY_SCHEMES.has(scheme)) return false
            return allowed.has(scheme)
        },
        [allowed]
    )

    return { allowed, allow, isAllowed }
}

// ── UriConfirmContext — one dialog per markdown root ────────────────────────

type DialogState = {
    url: string
    scheme: string
} | null

type UriConfirmContextValue = {
    openUri: (url: string, scheme: string) => void
    /** Shared isAllowed so all <a> tags in this tree re-render on the same state update. */
    isAllowed: (scheme: string) => boolean
}

const UriConfirmContext = createContext<UriConfirmContextValue | null>(null)

/**
 * Provider that mounts a single <UriConfirmDialog> for all <a> links in its
 * subtree. Wrap each MarkdownText / MarkdownRenderer / Reasoning surface with
 * this so that only one dialog instance exists per markdown root instead of
 * one per <a> tag.
 *
 * The allowed-schemes state lives here so all child <A> components share the
 * same React state — when "Always allow" is clicked, every link in the tree
 * re-renders in the same React commit (no cross-tab storage event required).
 */
export function UriConfirmProvider({ children }: { children: ReactNode }) {
    const [dialog, setDialog] = useState<DialogState>(null)
    const { allow, isAllowed } = useAllowedSchemes()

    const openUri = useCallback((url: string, scheme: string) => {
        setDialog({ url, scheme })
    }, [])

    const closeDialog = () => setDialog(null)

    const handleOpen = () => {
        if (!dialog) return
        closeDialog()
        window.open(dialog.url, '_blank', 'noopener,noreferrer')
    }

    const handleAlwaysAllow = (allowedScheme: string) => {
        allow(allowedScheme)
        closeDialog()
        if (dialog) {
            window.open(dialog.url, '_blank', 'noopener,noreferrer')
        }
    }

    const contextValue = useMemo(() => ({ openUri, isAllowed }), [openUri, isAllowed])

    return (
        <UriConfirmContext.Provider value={contextValue}>
            {children}
            {dialog !== null && (
                <UriConfirmDialog
                    open={true}
                    url={dialog.url}
                    scheme={dialog.scheme}
                    onCancel={closeDialog}
                    onOpen={handleOpen}
                    onAlwaysAllow={handleAlwaysAllow}
                />
            )}
        </UriConfirmContext.Provider>
    )
}

// ── Components ───────────────────────────────────────────────────────────────

function CodeHeader(props: CodeHeaderProps) {
    const { copied, copy } = useCopyToClipboard()
    const language = props.language && props.language !== 'unknown' ? props.language : 'text'

    return (
        <div className="aui-code-shell-header flex items-center justify-between gap-3 rounded-t-xl bg-[var(--app-code-header-bg)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">
            <div className="min-w-0 flex-1 truncate font-mono">
                {language}
            </div>
            <button
                type="button"
                onClick={() => copy(props.code)}
                className="shrink-0 rounded-md p-1 text-[var(--app-code-header-fg)] transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)]"
                title="Copy"
            >
                {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            </button>
        </div>
    )
}

function Pre(props: ComponentPropsWithoutRef<'pre'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-pre-wrapper min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden">
            <pre
                {...rest}
                className={cn(
                    'aui-md-pre m-0 w-max min-w-full rounded-b-xl bg-[var(--app-code-bg)] px-4 py-3 text-sm',
                    className
                )}
            />
        </div>
    )
}

function Code(props: ComponentPropsWithoutRef<'code'>) {
    const isCodeBlock = useIsMarkdownCodeBlock()

    if (isCodeBlock) {
        return (
            <code
                {...props}
                className={cn('aui-md-codeblockcode font-mono', props.className)}
            />
        )
    }

    return (
        <code
            {...props}
            className={cn(
                'aui-md-code break-words rounded-md border border-[var(--app-inline-code-border)] bg-[var(--app-inline-code-bg)] px-[0.38em] py-[0.14em] font-mono text-[0.88em] text-[var(--app-inline-code-fg)]',
                props.className
            )}
        />
    )
}

function FilePathAnchor(props: ComponentPropsWithoutRef<'a'> & { filePath: string; sessionId: string }) {
    const navigate = useNavigate()
    const rel = props.target === '_blank' ? (props.rel ?? 'noreferrer') : props.rel
    const search = new URLSearchParams({ path: encodeBase64(props.filePath) }).toString()
    const href = `/sessions/${encodeURIComponent(props.sessionId)}/file?${search}`

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        props.onClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

        event.preventDefault()
        void navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId: props.sessionId },
            search: { path: encodeBase64(props.filePath) }
        })
    }

    return (
        <a
            {...props}
            href={href}
            rel={rel}
            onClick={handleClick}
            className={cn('aui-md-a font-medium text-[var(--app-link)] underline decoration-[color:var(--app-link-muted)] underline-offset-3', props.className)}
        />
    )
}

/**
 * Anchor component with URI scheme policy enforcement.
 *
 * - Relative / no-scheme hrefs (/settings, ./foo, #section, ?q=1): passed through
 *   without interception so the browser or SPA router can navigate normally.
 * - IANA safe schemes (https/http/mailto/irc/ircs/xmpp): navigate directly.
 * - Deny schemes (javascript/data/vbscript/file): silently block. denyOnlyTransform
 *   already strips the href to "", so href="" in DOM (belt-and-suspenders onClick
 *   guard also calls preventDefault).
 * - Custom schemes, NOT yet allowed by user: href="#" in DOM (not the live URL)
 *   so middle-click / drag-to-bar cannot bypass the dialog. Dialog opens on left-click
 *   via the shared UriConfirmContext (single dialog per markdown root).
 * - Custom schemes, already allowed by user: live href in DOM; middle-click works.
 * - File-path links (decoded by remarkFilePathLinks): delegated to FilePathAnchor
 *   which uses useNavigate for SPA routing.
 */
function A(props: ComponentPropsWithoutRef<'a'>) {
    const chat = useOptionalHappyChatContext()
    // useContext must be called unconditionally before any early return so that
    // the Rules of Hooks are satisfied regardless of whether `filePath` is set.
    // isAllowed comes exclusively from the shared context. Every call site
    // (MarkdownText, Reasoning, MarkdownRenderer) wraps its surface with
    // <UriConfirmProvider>, so ctx is always present in production.
    //
    // The previous localHook fallback instantiated useAllowedSchemes() even
    // when ctx was present — 20 anchors → 21 storage listeners per mount.
    // Removing it requires tests that render <A> directly to wrap with
    // <UriConfirmProvider> (or supply a mock UriConfirmContext.Provider).
    const ctx = useContext(UriConfirmContext)
    const filePath = typeof props.href === 'string' ? decodeFilePathHref(props.href) : null
    const rel = props.target === '_blank' ? (props.rel ?? 'noreferrer') : props.rel

    if (filePath) {
        if (!chat) {
            return <>{props.children}</>
        }
        return <FilePathAnchor {...props} filePath={filePath} sessionId={chat.sessionId} />
    }

    const isAllowed = ctx?.isAllowed ?? (() => false)

    const { onClick, href, ...rest } = props
    // Relative / no-scheme hrefs (/settings, ./foo, #section, ?q=1) must not be
    // classified via classifyScheme — it returns 'deny' for inputs with no valid
    // scheme, which previously caused the onClick handler to preventDefault and
    // silently break all relative markdown links. Treat them as 'iana' so the
    // browser or SPA router can navigate normally.
    const isRelative = href ? !hasScheme(href) : false
    const classification = href && !isRelative ? classifyScheme(href) : 'iana'
    const colonIdx = href ? href.indexOf(':') : -1
    const scheme = colonIdx > 0 && !isRelative ? href!.slice(0, colonIdx).toLowerCase() : ''
    const isCustomAllowed = classification === 'custom' && isAllowed(scheme)

    const domHref =
        classification === 'iana' || isCustomAllowed
            ? href
            : classification === 'custom'
                ? '#'
                : href

    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        const url = href ?? ''

        if (!url) {
            e.preventDefault()
            return
        }

        if (classification === 'deny') {
            e.preventDefault()
            return
        }

        if (classification === 'iana') {
            onClick?.(e)
            return
        }

        if (isCustomAllowed) {
            onClick?.(e)
            return
        }

        // Unallowed custom scheme: show confirmation dialog via context.
        e.preventDefault()
        ctx?.openUri(url, scheme)
    }

    return (
        <a
            {...rest}
            href={domHref}
            rel={rel}
            onClick={handleClick}
            className={cn('aui-md-a font-medium text-[var(--app-link)] underline decoration-[color:var(--app-link-muted)] underline-offset-3', props.className)}
        />
    )
}

function Paragraph(props: ComponentPropsWithoutRef<'p'>) {
    return <p {...props} className={cn('aui-md-p my-2.5 leading-7 first:mt-0 last:mb-0', props.className)} />
}

function Blockquote(props: ComponentPropsWithoutRef<'blockquote'>) {
    return (
        <blockquote
            {...props}
            className={cn(
                'aui-md-blockquote my-3 rounded-r-2xl border-l-[3px] border-[var(--app-md-quote-border)] bg-[var(--app-md-quote-bg)] px-4 py-3 text-[var(--app-md-quote-fg)]',
                props.className
            )}
        />
    )
}

function UnorderedList(props: ComponentPropsWithoutRef<'ul'>) {
    return <ul {...props} className={cn('aui-md-ul my-2.5 list-disc pl-6 marker:text-[var(--app-hint)] [&>li]:mt-1.5', props.className)} />
}

function OrderedList(props: ComponentPropsWithoutRef<'ol'>) {
    return <ol {...props} className={cn('aui-md-ol my-2.5 list-decimal pl-6 marker:text-[var(--app-hint)] [&>li]:mt-1.5', props.className)} />
}

function ListItem(props: ComponentPropsWithoutRef<'li'>) {
    return <li {...props} className={cn('aui-md-li leading-7', props.className)} />
}

function Hr(props: ComponentPropsWithoutRef<'hr'>) {
    return <hr {...props} className={cn('aui-md-hr my-4 border-[var(--app-divider)]', props.className)} />
}

function Table(props: ComponentPropsWithoutRef<'table'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-table-wrapper my-3 max-w-full overflow-x-auto rounded-xl bg-[var(--app-md-table-bg)]">
            <table {...rest} className={cn('aui-md-table w-full border-collapse text-sm', className)} />
        </div>
    )
}

function Thead(props: ComponentPropsWithoutRef<'thead'>) {
    return <thead {...props} className={cn('aui-md-thead bg-[var(--app-md-table-head-bg)]', props.className)} />
}

function Tbody(props: ComponentPropsWithoutRef<'tbody'>) {
    return <tbody {...props} className={cn('aui-md-tbody', props.className)} />
}

function Tr(props: ComponentPropsWithoutRef<'tr'>) {
    return <tr {...props} className={cn('aui-md-tr border-t border-[var(--app-divider)] first:border-t-0', props.className)} />
}

function Th(props: ComponentPropsWithoutRef<'th'>) {
    return (
        <th
            {...props}
            className={cn(
                'aui-md-th px-3 py-2 text-left font-semibold text-[var(--app-fg)] [[align=center]]:text-center [[align=right]]:text-right',
                props.className
            )}
        />
    )
}

function Td(props: ComponentPropsWithoutRef<'td'>) {
    return <td {...props} className={cn('aui-md-td px-3 py-2 align-top text-[var(--app-fg)] [[align=center]]:text-center [[align=right]]:text-right', props.className)} />
}

function H1(props: ComponentPropsWithoutRef<'h1'>) {
    return <h1 {...props} className={cn('aui-md-h1 mt-4 text-[1.05rem] font-semibold tracking-[-0.01em] first:mt-0', props.className)} />
}

function H2(props: ComponentPropsWithoutRef<'h2'>) {
    return <h2 {...props} className={cn('aui-md-h2 mt-4 text-base font-semibold tracking-[-0.01em] first:mt-0', props.className)} />
}

function H3(props: ComponentPropsWithoutRef<'h3'>) {
    return <h3 {...props} className={cn('aui-md-h3 mt-3 text-[0.95rem] font-semibold first:mt-0', props.className)} />
}

function H4(props: ComponentPropsWithoutRef<'h4'>) {
    return <h4 {...props} className={cn('aui-md-h4 mt-3 text-[0.92rem] font-semibold first:mt-0', props.className)} />
}

function H5(props: ComponentPropsWithoutRef<'h5'>) {
    return <h5 {...props} className={cn('aui-md-h5 mt-2.5 text-[0.9rem] font-semibold first:mt-0', props.className)} />
}

function H6(props: ComponentPropsWithoutRef<'h6'>) {
    return <h6 {...props} className={cn('aui-md-h6 mt-2.5 text-[0.88rem] font-semibold first:mt-0', props.className)} />
}

function Strong(props: ComponentPropsWithoutRef<'strong'>) {
    return <strong {...props} className={cn('aui-md-strong font-semibold text-[var(--app-fg)]', props.className)} />
}

function Em(props: ComponentPropsWithoutRef<'em'>) {
    return <em {...props} className={cn('aui-md-em italic', props.className)} />
}

function Image(props: ComponentPropsWithoutRef<'img'>) {
    return <img {...props} className={cn('aui-md-img my-3 max-w-full rounded-xl', props.className)} />
}

export const defaultComponents = memoizeMarkdownComponents({
    SyntaxHighlighter,
    CodeHeader,
    pre: Pre,
    code: Code,
    h1: H1,
    h2: H2,
    h3: H3,
    h4: H4,
    h5: H5,
    h6: H6,
    a: A,
    p: Paragraph,
    strong: Strong,
    em: Em,
    blockquote: Blockquote,
    ul: UnorderedList,
    ol: OrderedList,
    li: ListItem,
    hr: Hr,
    table: Table,
    thead: Thead,
    tbody: Tbody,
    tr: Tr,
    th: Th,
    td: Td,
    img: Image,
} as const)

export function MarkdownText() {
    return (
        <UriConfirmProvider>
            <MarkdownTextPrimitive
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={defaultComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                urlTransform={denyOnlyTransform}
                className={cn(MARKDOWN_CLASSNAME)}
            />
        </UriConfirmProvider>
    )
}
