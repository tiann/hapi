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
                fitContentKey={lightboxOpen ? svg : null}
            >
                <MermaidSvgContent
                    svg={svg}
                    className="[&_svg]:block [&_svg]:h-auto [&_svg]:max-h-none [&_svg]:max-w-none [&_svg]:w-auto"
                />
            </ZoomableLightbox>
        </>
    )
}
