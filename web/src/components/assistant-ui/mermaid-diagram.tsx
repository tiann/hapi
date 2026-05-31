import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useEffect, useId, useState, type ComponentPropsWithoutRef, type SyntheticEvent } from 'react'
import { ZoomableLightbox } from '@/components/ZoomableLightbox'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

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
                actorBkg: '#323843',
                actorBorder: '#6d8fd6',
                actorTextColor: '#edf1f5',
                signalColor: '#94a3b8',
                labelBoxBkgColor: '#323843',
                labelTextColor: '#edf1f5',
                loopTextColor: '#edf1f5',
                noteBkgColor: '#2d3440',
                noteTextColor: '#edf1f5',
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
                actorBkg: '#f8fbff',
                actorBorder: '#b8cdfd',
                actorTextColor: '#2d333b',
                signalColor: '#94a3b8',
                labelBoxBkgColor: '#f8fbff',
                labelTextColor: '#2d333b',
                loopTextColor: '#2d333b',
                noteBkgColor: '#eef4ff',
                noteTextColor: '#2d333b',
            },
    })

    initializedTheme = theme
    return mermaid
}

export async function renderMermaidSvg(
    code: string,
    elementId: string,
    theme: 'light' | 'dark',
): Promise<string | null> {
    const mermaid = await ensureMermaid(theme)
    const isValid = await mermaid.parse(code, { suppressErrors: true })
    if (!isValid) return null
    const result = await mermaid.render(elementId, code)
    return result.svg
}

function parseViewBoxSize(svg: string): { width: number; height: number } | null {
    const viewBoxMatch = svg.match(/\bviewBox="([\d.\s]+)"/)
    if (!viewBoxMatch) return null
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number)
    if (parts.length < 4 || parts[2] <= 0 || parts[3] <= 0) return null
    return { width: parts[2], height: parts[3] }
}

/** Mermaid often emits width="100%"; normalize before rasterizing for the lightbox. */
export function normalizeMermaidSvgForStandaloneDisplay(svg: string): string {
    let result = svg
    const viewBoxSize = parseViewBoxSize(result)
    if (!viewBoxSize) return result

    const { width, height } = viewBoxSize
    result = result.replace(/\swidth="100%"/gi, '')
    result = result.replace(/\sheight="100%"/gi, '')

    if (/\sstyle="/i.test(result)) {
        result = result.replace(
            /(<svg[^>]*?\sstyle=")([^"]*)(")/i,
            (_full, prefix: string, style: string, suffix: string) => {
                const cleaned = style
                    .replace(/(?:^|;)\s*max-width:\s*[^;]+/gi, '')
                    .replace(/(?:^|;)\s*width:\s*[^;]+/gi, '')
                    .replace(/(?:^|;)\s*height:\s*[^;]+/gi, '')
                    .replace(/^;+|;+$/g, '')
                    .replace(/;\s*;/g, ';')
                    .trim()
                const nextStyle = cleaned
                    ? `${cleaned};width:${width}px;height:${height}px`
                    : `width:${width}px;height:${height}px`
                return `${prefix}${nextStyle}${suffix}`
            },
        )
    } else {
        result = result.replace(
            /<svg/i,
            `<svg width="${width}" height="${height}"`,
        )
    }

    if (!/\bwidth="/i.test(result.split('>')[0] ?? '')) {
        result = result.replace(/<svg/i, `<svg width="${width}" height="${height}"`)
    }

    return result
}

function MermaidFallback(props: ComponentPropsWithoutRef<'pre'> & { code: string }) {
    const { code, className, ...rest } = props
    return (
        <pre
            {...rest}
            className={cn(
                'aui-mermaid-fallback m-0 overflow-x-auto rounded-b-xl bg-[var(--app-code-bg)] p-4 text-sm text-[var(--app-fg)]',
                className
            )}
        >
            <code>{code}</code>
        </pre>
    )
}

function MermaidSvgContent(props: { svg: string; className?: string }) {
    return (
        <div
            className={cn('min-w-fit [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full', props.className)}
            dangerouslySetInnerHTML={{ __html: props.svg }}
        />
    )
}

export function MermaidDiagram(props: SyntaxHighlighterProps) {
    const { t } = useTranslation()
    const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme())
    const [renderError, setRenderError] = useState(false)
    const [svg, setSvg] = useState<string | null>(null)
    const [lightboxOpen, setLightboxOpen] = useState(false)
    const [lightboxSvg, setLightboxSvg] = useState<string | null>(null)
    const [lightboxLoading, setLightboxLoading] = useState(false)
    const id = useId().replace(/:/g, '-')
    const openLabel = t('mermaid.openFullscreen')
    const viewerLabel = t('mermaid.viewerTitle')

    const stopEvent = (event: SyntheticEvent) => {
        event.stopPropagation()
    }

    const openLightbox = (event: SyntheticEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setLightboxOpen(true)
    }

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

    useEffect(() => {
        let cancelled = false

        const render = async () => {
            try {
                const nextSvg = await renderMermaidSvg(props.code, `mermaid-${id}`, theme)
                if (cancelled) return
                if (!nextSvg) {
                    setSvg(null)
                    setRenderError(true)
                    return
                }
                setSvg(nextSvg)
                setRenderError(false)
            } catch {
                if (cancelled) return
                setSvg(null)
                setRenderError(true)
            }
        }

        void render()

        return () => {
            cancelled = true
        }
    }, [id, props.code, theme])

    useEffect(() => {
        if (!lightboxOpen) {
            setLightboxSvg(null)
            setLightboxLoading(false)
            return
        }

        let cancelled = false
        setLightboxLoading(true)

        const render = async () => {
            try {
                const nextSvg = await renderMermaidSvg(props.code, `mermaid-modal-${id}`, theme)
                if (cancelled) return
                setLightboxSvg(normalizeMermaidSvgForStandaloneDisplay(nextSvg))
            } catch {
                if (cancelled) return
                setLightboxSvg(null)
            } finally {
                if (!cancelled) setLightboxLoading(false)
            }
        }

        void render()

        return () => {
            cancelled = true
        }
    }, [id, lightboxOpen, props.code, theme])

    if (renderError || !svg) {
        return <MermaidFallback code={props.code} data-mermaid-diagram data-rendered="false" />
    }

    return (
        <>
            <button
                type="button"
                aria-label={openLabel}
                title={openLabel}
                onPointerDown={stopEvent}
                onMouseDown={stopEvent}
                onTouchStart={stopEvent}
                onClick={openLightbox}
                className="aui-mermaid-diagram w-full cursor-zoom-in overflow-x-auto rounded-b-xl bg-[var(--app-code-bg)] px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                data-mermaid-diagram
                data-rendered="true"
                data-mermaid-source={encodeURIComponent(props.code)}
            >
                <MermaidSvgContent svg={svg} />
            </button>

            <ZoomableLightbox
                open={lightboxOpen}
                onClose={() => setLightboxOpen(false)}
                title={viewerLabel}
                ariaLabel={viewerLabel}
                fitContentKey={lightboxOpen ? lightboxSvg : null}
            >
                <div className="rounded-lg bg-[var(--app-code-bg)] px-3 py-3">
                    {lightboxLoading ? (
                        <div className="px-8 py-6 text-sm text-white/80">{t('mermaid.loading')}</div>
                    ) : lightboxSvg ? (
                        <MermaidSvgContent
                            svg={lightboxSvg}
                            className="[&_svg]:block [&_svg]:h-auto [&_svg]:max-h-none [&_svg]:max-w-none [&_svg]:w-auto"
                        />
                    ) : (
                        <div className="px-8 py-6 text-sm text-white/80">{t('mermaid.renderError')}</div>
                    )}
                </div>
            </ZoomableLightbox>
        </>
    )
}
