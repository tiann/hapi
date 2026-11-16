import { useEffect, useRef, useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { inlineHtmlAssets } from '@/lib/file-html-preview'
import { useTranslation } from '@/lib/use-translation'

const MAX_ASSET_FILE_BYTES = 4 * 1024 * 1024
const PREVIEW_SANDBOX = 'allow-scripts'

/**
 * Opens the preview in a new tab. The tab itself is an inert about:blank
 * shell (same origin as HAPI, but it runs no code); the page still renders in
 * a sandboxed iframe there, so it never gets HAPI's origin.
 */
export function openHtmlPreviewWindow(srcDoc: string, title: string): void {
    const win = window.open('', '_blank')
    if (!win) return
    win.opener = null
    const doc = win.document
    doc.title = title
    const style = doc.createElement('style')
    style.textContent = 'html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0;background:#fff}'
    const frame = doc.createElement('iframe')
    frame.setAttribute('sandbox', PREVIEW_SANDBOX)
    frame.title = title
    frame.srcdoc = srcDoc
    doc.head.append(style)
    doc.body.append(frame)
}

/**
 * Renders a workspace HTML file in a sandboxed iframe. Scripts run, but
 * without `allow-same-origin` the page gets an opaque origin: it cannot read
 * HAPI's storage, cookies or parent window, open popups, or navigate the top page.
 */
export function HtmlFilePreview(props: { sessionId: string; filePath: string; html: string }) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [srcDoc, setSrcDoc] = useState<string | null>(null)
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const fileName = props.filePath.split('/').pop() || props.filePath

    useEffect(() => {
        let cancelled = false
        setSrcDoc(null)
        const readFile = async (path: string) => {
            const result = await api.readSessionFile(props.sessionId, path, MAX_ASSET_FILE_BYTES)
            return result.success && result.content ? result.content : null
        }
        inlineHtmlAssets(props.html, props.filePath, readFile)
            .catch(() => props.html)
            .then((doc) => {
                if (!cancelled) setSrcDoc(doc)
            })
        return () => {
            cancelled = true
        }
    }, [api, props.sessionId, props.filePath, props.html])

    if (srcDoc === null) {
        return <div className="text-sm text-[var(--app-hint)]">{t('loading.file')}</div>
    }

    const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled
    const buttonClass = 'rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end gap-1">
                {canFullscreen ? (
                    <button
                        type="button"
                        className={buttonClass}
                        onClick={() => void iframeRef.current?.requestFullscreen().catch(() => undefined)}
                    >
                        {t('file.page.htmlFullscreen')}
                    </button>
                ) : null}
                <button
                    type="button"
                    className={buttonClass}
                    onClick={() => openHtmlPreviewWindow(srcDoc, fileName)}
                >
                    {t('file.page.htmlOpenInNewWindow')}
                </button>
            </div>
            <iframe
                ref={iframeRef}
                title={props.filePath}
                sandbox={PREVIEW_SANDBOX}
                srcDoc={srcDoc}
                className="block h-[75dvh] w-full rounded-md border border-[var(--app-border)] bg-white"
            />
        </div>
    )
}
