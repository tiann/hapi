import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useAssistantState } from '@assistant-ui/react'
import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef } from 'react'

// useAssistantState throws when rendered outside an AssistantRuntimeProvider
// (e.g. MarkdownRenderer in tool cards / request footers). Return null there.
function useOptionalMessageId(): string | null {
    try {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return useAssistantState(({ message }) => message.id)
    } catch {
        return null
    }
}
import { cn } from '@/lib/utils'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { subscribePatch } from '@/lib/patch-emitter'

// ── Theme bootstrap ──────────────────────────────────────────────────────────

let initializedTheme: 'light' | 'dark' | null = null
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

async function getMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = import('mermaid').then((module) => module.default)
    }
    return mermaidPromise
}

function resolveTheme() {
    if (typeof document === 'undefined') return 'light' as const
    return document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const
}

async function ensureMermaid(theme: 'light' | 'dark') {
    const mermaid = await getMermaid()
    if (initializedTheme === theme) return mermaid

    mermaid.setParseErrorHandler(() => undefined)

    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'dark' ? 'dark' : 'default',
        themeVariables: theme === 'dark'
            ? {
                primaryColor: '#323843',
                primaryTextColor: '#edf1f5',
                primaryBorderColor: '#6d8fd6',
                lineColor: '#94a3b8',
                tertiaryColor: '#2d3440',
                background: '#2a2f35',
                mainBkg: '#323843',
                secondBkg: '#2d3440',
                tertiaryBkg: '#29313b',
                clusterBkg: '#2d3440',
                clusterBorder: '#6d8fd6',
                edgeLabelBackground: '#2a2f35',
            }
            : {
                primaryColor: '#f8fbff',
                primaryTextColor: '#2d333b',
                primaryBorderColor: '#b8cdfd',
                lineColor: '#94a3b8',
                tertiaryColor: '#eef4ff',
                background: '#f5f6f7',
                mainBkg: '#f8fbff',
                secondBkg: '#eef4ff',
                tertiaryBkg: '#edf3fb',
                clusterBkg: '#eef4ff',
                clusterBorder: '#b8cdfd',
                edgeLabelBackground: '#f5f6f7',
            },
    })

    initializedTheme = theme
    return mermaid
}

// ── Per-message block-index registry ────────────────────────────────────────
//
// Mermaid blocks within a given message are numbered 0, 1, 2, … in DOM order.
// We need a stable integer index per instance so the hub can correlate
// patch-request / message-patched pairs.
//
// Strategy: a module-level counter map keyed by msgId, incremented once per
// component instance on first mount.  The counter is claimed via a ref so
// each instance owns a stable blockIndex for its lifetime.

const msgBlockCounters = new Map<string, number>()

function claimBlockIndex(msgId: string): number {
    const next = msgBlockCounters.get(msgId) ?? 0
    msgBlockCounters.set(msgId, next + 1)
    return next
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MermaidFallback(props: ComponentPropsWithoutRef<'pre'> & { code: string }) {
    return (
        <pre
            className={cn(
                'aui-mermaid-fallback m-0 overflow-x-auto rounded-b-xl bg-[var(--app-code-bg)] p-4 text-sm text-[var(--app-fg)]',
                props.className
            )}
        >
            <code>{props.code}</code>
        </pre>
    )
}

function MermaidPatchingPlaceholder() {
    return (
        <div
            data-mermaid-diagram
            data-rendered="patching"
            className="aui-mermaid-patching flex items-center gap-2 rounded-b-xl bg-[var(--app-code-bg)] px-4 py-3 text-sm text-[var(--app-hint)]"
        >
            <svg
                className="h-3.5 w-3.5 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
            >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span>rendering diagram…</span>
        </div>
    )
}

// ── Main component ───────────────────────────────────────────────────────────

const MAX_PATCH_RETRIES = 2

export function MermaidDiagram(props: SyntaxHighlighterProps) {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme())
    const [svg, setSvg] = useState<string | null>(null)

    // 'idle'      — initial / rendering in progress
    // 'ok'        — rendered successfully
    // 'patching'  — sent patch-request, waiting for corrected code
    // 'error'     — render failed and retries exhausted
    const [status, setStatus] = useState<'idle' | 'ok' | 'patching' | 'error'>('idle')

    // Code to render — starts as props.code, replaced by corrected code from patch
    const [renderCode, setRenderCode] = useState(props.code)

    const id = useId().replace(/:/g, '-')

    // Stable blockIndex claimed once per instance.
    // msgId is null when rendering outside an assistant message (tool cards, etc.)
    // — in that case the patch loop is disabled and we fall back to error display.
    const msgId = useOptionalMessageId()
    const canPatch = msgId !== null
    const blockKey = msgId ?? `standalone:${id}`
    const blockIndexRef = useRef<number | null>(null)
    if (blockIndexRef.current === null) {
        blockIndexRef.current = claimBlockIndex(blockKey)
    }
    const blockIndex = blockIndexRef.current

    const chat = useOptionalHappyChatContext()
    const chatRef = useRef(chat)
    chatRef.current = chat
    const patchRetriesRef = useRef(0)

    // Theme observer
    useEffect(() => {
        if (typeof document === 'undefined') return undefined

        const root = document.documentElement
        const observer = new MutationObserver(() => {
            setTheme(resolveTheme())
        })

        observer.observe(root, {
            attributes: true,
            attributeFilter: ['data-theme'],
        })

        return () => observer.disconnect()
    }, [])

    // Render effect
    useEffect(() => {
        let cancelled = false

        const handleRenderFailure = () => {
            if (cancelled) return
            const currentChat = chatRef.current
            if (!canPatch || !currentChat || patchRetriesRef.current >= MAX_PATCH_RETRIES) {
                setSvg(null)
                setStatus('error')
                return
            }
            patchRetriesRef.current += 1
            setStatus('patching')
            setSvg(null)
            void currentChat.api.sendPatchRequest(currentChat.sessionId, {
                msgId: msgId!,
                blockIndex,
                type: 'mermaid',
                failedCode: renderCode
            }).catch(() => {
                // If the request fails and the component is still mounted,
                // fall back to showing the raw code.
                if (!cancelled) {
                    setStatus('error')
                }
            })
        }

        const render = async () => {
            try {
                const mermaid = await ensureMermaid(theme)
                const isValid = await mermaid.parse(renderCode, { suppressErrors: true })
                if (cancelled) return

                if (!isValid) {
                    handleRenderFailure()
                    return
                }

                const result = await mermaid.render(`mermaid-${id}`, renderCode)
                if (cancelled) return
                setSvg(result.svg)
                setStatus('ok')
            } catch {
                if (cancelled) return
                handleRenderFailure()
            }
        }

        void render()

        return () => {
            cancelled = true
        }
    }, [id, renderCode, theme, msgId, blockIndex])

    // Subscribe to message-patched events. Also set a 15s fallback so the
    // component never hangs in 'patching' forever (e.g. CLI crash, lost response).
    useEffect(() => {
        if (status !== 'patching' || !msgId) return undefined

        const timer = setTimeout(() => setStatus('error'), 15_000)

        const unsubscribe = subscribePatch((payload) => {
            if (payload.sessionId !== chat?.sessionId) return
            if (payload.msgId !== msgId) return
            if (payload.blockIndex !== blockIndex) return
            clearTimeout(timer)
            setRenderCode(payload.correctedCode)
            setStatus('idle')
        })

        return () => {
            clearTimeout(timer)
            unsubscribe()
        }
    }, [status, chat?.sessionId, msgId, blockIndex])

    // Reset renderCode if the original props.code changes (e.g. streaming)
    useEffect(() => {
        setRenderCode(props.code)
        patchRetriesRef.current = 0
        setStatus('idle')
    }, [props.code])

    if (status === 'patching') {
        return <MermaidPatchingPlaceholder />
    }

    if (status === 'error' || (status !== 'ok' && !svg)) {
        // Still 'idle' (initial render in progress) — show nothing yet to avoid
        // flash of fallback.  Once renderCode resolves we'll update status.
        if (status === 'idle') {
            return null
        }
        return <MermaidFallback code={props.code} data-mermaid-diagram data-rendered="false" />
    }

    return (
        <div
            data-mermaid-diagram
            data-rendered="true"
            className="aui-mermaid-diagram overflow-x-auto rounded-b-xl bg-[var(--app-code-bg)] px-4 py-3"
        >
            <div
                className="min-w-fit [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: svg! }}
            />
        </div>
    )
}
