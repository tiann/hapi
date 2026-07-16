import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

type ShareTurnDialogProps = {
    isOpen: boolean
    title: string
    subtitle: string
    sourceSnapshots: Array<{
        html: string
        text: string
        role?: 'user' | 'assistant'
    }>
    onClose: () => void
}

type ShareTurnSnapshot = ShareTurnDialogProps['sourceSnapshots'][number]

const SHARE_EXPORT_WIDTH = 960
const SHARE_EXPORT_SCALE = 2
const MAX_EXPORT_PIXELS = 24_000_000

function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        window.requestAnimationFrame(() => resolve())
    })
}

function stripCaptureOnlyControls(root: HTMLElement): void {
    for (const element of Array.from(root.querySelectorAll('[data-hapi-share-exclude="true"], .aui-reasoning-group'))) {
        element.remove()
    }
    for (const element of Array.from(root.querySelectorAll('.happy-message-actions-first-line, [data-hapi-share-action="true"], button[aria-expanded], button[title="Copy"], input, textarea, select'))) {
        element.remove()
    }
    for (const anchor of Array.from(root.querySelectorAll('a'))) {
        anchor.removeAttribute('href')
        anchor.removeAttribute('target')
        anchor.removeAttribute('rel')
    }
    for (const element of Array.from(root.querySelectorAll('[role="button"], [contenteditable="true"]'))) {
        if (element.tagName.toLowerCase() !== 'a') {
            element.removeAttribute('role')
        }
        element.removeAttribute('contenteditable')
        element.removeAttribute('tabindex')
    }
}

function formatShareTimestamp(date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('')
}

function getShareFileName(): string {
    return `HAPI-${formatShareTimestamp()}.png`
}

function prepareExportElement(element: HTMLElement): HTMLElement {
    const captureElement = element.cloneNode(true)
    if (!(captureElement instanceof HTMLElement)) {
        throw new Error('Failed to prepare shared image')
    }

    const elementStyle = getComputedStyle(element)
    const backgroundColor = elementStyle.backgroundColor && elementStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? elementStyle.backgroundColor
        : (getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim() || '#ffffff')
    const color = elementStyle.color || getComputedStyle(document.documentElement).getPropertyValue('--app-fg').trim() || '#111827'

    captureElement.classList.add('hapi-share-export-root')
    captureElement.style.cssText += [
        'position:absolute',
        'left:0',
        'top:0',
        'z-index:-1',
        `width:${SHARE_EXPORT_WIDTH}px`,
        `max-width:${SHARE_EXPORT_WIDTH}px`,
        'box-sizing:border-box',
        'transform:none',
        'pointer-events:none',
        'overflow:visible',
        '-webkit-text-size-adjust:100%',
        'text-size-adjust:100%',
        'font-size:14px',
        'line-height:1.6',
        `background:${backgroundColor}`,
        `color:${color}`
    ].join(';')

    const style = document.createElement('style')
    style.textContent = `
        .hapi-share-export-root {
            background: ${backgroundColor} !important;
            color: ${color} !important;
            box-sizing: border-box !important;
            -webkit-text-size-adjust: 100% !important;
            text-size-adjust: 100% !important;
            font-size: 14px !important;
            line-height: 1.6 !important;
        }
        .hapi-share-export-root [data-hapi-share-exclude="true"],
        .hapi-share-export-root .aui-reasoning-group,
        .hapi-share-export-root button[aria-expanded],
        .hapi-share-export-root button[title="Copy"] {
            display: none !important;
        }
        .hapi-share-export-root img,
        .hapi-share-export-root video,
        .hapi-share-export-root canvas,
        .hapi-share-export-root svg {
            max-width: 100% !important;
            height: auto !important;
            object-fit: contain !important;
        }
        .hapi-share-export-root button:has(img),
        .hapi-share-export-root img {
            max-height: 16rem !important;
        }
        .hapi-share-export-root button:has(img) {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: auto !important;
            min-width: 0 !important;
            min-height: 0 !important;
            max-width: 100% !important;
            overflow: hidden !important;
            border: 0 !important;
            padding: 0 !important;
            background: transparent !important;
            color: transparent !important;
            vertical-align: top !important;
        }
        .hapi-share-export-root button:has(img) img {
            display: block !important;
            max-width: min(100%, 18rem) !important;
            max-height: 12rem !important;
            border-radius: 0.75rem !important;
        }
        .hapi-share-export-root button:has(img) > :not(img) {
            display: none !important;
        }
        .hapi-share-export-root .sr-only {
            display: none !important;
        }
        .hapi-share-export-root pre,
        .hapi-share-export-root code {
            white-space: pre-wrap !important;
            overflow-wrap: anywhere !important;
        }
    `
    captureElement.prepend(style)
    return captureElement
}

function waitForFrameLoad(frame: HTMLIFrameElement): Promise<void> {
    return new Promise((resolve) => {
        if (frame.contentDocument?.readyState === 'complete') {
            resolve()
            return
        }
        frame.addEventListener('load', () => resolve(), { once: true })
        window.setTimeout(() => resolve(), 1000)
    })
}

function waitForStyleSheets(document: Document): Promise<void> {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    return Promise.all(links.map((link) => {
        if (link.sheet) return Promise.resolve()
        return new Promise<void>((resolve) => {
            link.addEventListener('load', () => resolve(), { once: true })
            link.addEventListener('error', () => resolve(), { once: true })
            window.setTimeout(() => resolve(), 2500)
        })
    })).then(() => undefined)
}

function appendTextFallback(target: DocumentFragment | HTMLElement, snapshot: ShareTurnSnapshot): void {
    if (snapshot.text.trim().length === 0) return
    const fallback = document.createElement('div')
    fallback.className = snapshot.role === 'user'
        ? 'happy-user-bubble happy-chat-text ml-auto w-fit min-w-0 max-w-[92%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--app-chat-user-surface-bg)] px-4 py-2.5 text-[var(--app-chat-user-fg)] shadow-none'
        : 'whitespace-pre-wrap break-words rounded-2xl border border-[var(--app-border)] px-4 py-2.5 text-sm leading-6 text-[var(--app-fg)]'
    if (snapshot.role) fallback.dataset.hapiMessageRole = snapshot.role
    fallback.textContent = snapshot.text
    target.appendChild(fallback)
}

function resolveCssUrls(cssText: string, styleSheetUrl: string | null): string {
    if (!styleSheetUrl) return cssText
    return cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote: string, rawUrl: string) => {
        const url = rawUrl.trim()
        if (!url || /^(?:data:|blob:|#|[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return match
        try {
            return `url(${quote}${new URL(url, styleSheetUrl).href}${quote})`
        } catch {
            return match
        }
    })
}

function copyLoadedStyleSheets(source: Document, target: Document): void {
    const copiedOwners = new Set<Node>()
    const styleSheets = [
        ...Array.from(source.styleSheets),
        ...Array.from(source.adoptedStyleSheets ?? [])
    ]

    for (const sheet of styleSheets) {
        if (sheet.disabled) continue
        try {
            const cssText = resolveCssUrls(
                Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n'),
                sheet.href
            )
            if (!cssText) continue
            const style = target.createElement('style')
            style.dataset.hapiShareStyles = 'inlined'
            style.textContent = cssText
            target.head.appendChild(style)
            if (sheet.ownerNode) copiedOwners.add(sheet.ownerNode)
        } catch {
            // Cross-origin sheets cannot expose cssRules. Clone their owner as a
            // network fallback; same-origin app CSS always takes the inline path.
        }
    }

    for (const node of Array.from(source.head.querySelectorAll('link[rel="stylesheet"], style'))) {
        if (copiedOwners.has(node)) continue
        const clone = node.cloneNode(true)
        if (clone instanceof HTMLLinkElement && node instanceof HTMLLinkElement) {
            clone.href = node.href
            clone.crossOrigin = node.crossOrigin
        }
        target.head.appendChild(clone)
    }
}

async function waitForImages(root: HTMLElement): Promise<void> {
    const images = Array.from(root.querySelectorAll('img'))
    await Promise.all(images.map(async (image) => {
        if (image.complete && image.naturalWidth > 0) return
        try {
            if ('decode' in image) {
                await image.decode()
                return
            }
        } catch {
            // Fall through to load/error listeners.
        }
        await new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true })
            image.addEventListener('error', () => resolve(), { once: true })
            window.setTimeout(() => resolve(), 15000)
        })
    }))
}

async function waitForExportReady(root: HTMLElement): Promise<void> {
    const ownerDocument = root.ownerDocument
    await waitForStyleSheets(ownerDocument)
    if (ownerDocument.fonts) {
        await ownerDocument.fonts.ready.catch(() => undefined)
    }
    await waitForImages(root)
    await nextFrame()
    await nextFrame()
}

async function elementToPngBlob(element: HTMLElement): Promise<Blob> {
    const { default: html2canvas } = await import('html2canvas-pro')
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = [
        'position:fixed',
        'left:-10000px',
        'top:0',
        `width:${SHARE_EXPORT_WIDTH}px`,
        'height:1000px',
        'border:0',
        'opacity:0',
        'pointer-events:none'
    ].join(';')

    document.body.appendChild(frame)
    const frameDocument = frame.contentDocument
    if (!frameDocument) {
        frame.remove()
        throw new Error('Failed to prepare shared image')
    }
    frameDocument.open()
    frameDocument.write('<!doctype html><html><head></head><body></body></html>')
    frameDocument.close()
    await waitForFrameLoad(frame)
    frameDocument.documentElement.className = document.documentElement.className
    frameDocument.documentElement.setAttribute('style', document.documentElement.getAttribute('style') ?? '')
    for (const attr of Array.from(document.documentElement.attributes)) {
        if (attr.name === 'class' || attr.name === 'style') continue
        frameDocument.documentElement.setAttribute(attr.name, attr.value)
    }
    frameDocument.body.className = document.body.className
    frameDocument.body.setAttribute('style', [
        document.body.getAttribute('style') ?? '',
        'margin:0',
        `width:${SHARE_EXPORT_WIDTH}px`,
        'min-height:1000px',
        'overflow:visible',
        'background:transparent'
    ].join(';'))

    const base = frameDocument.createElement('base')
    base.href = document.baseURI
    frameDocument.head.appendChild(base)

    copyLoadedStyleSheets(document, frameDocument)

    const captureElement = prepareExportElement(element)
    captureElement.style.position = 'static'
    captureElement.style.left = 'auto'
    captureElement.style.top = 'auto'
    captureElement.style.zIndex = 'auto'
    frameDocument.body.appendChild(captureElement)
    let canvas: HTMLCanvasElement
    try {
        await waitForExportReady(captureElement)
        const captureWidth = captureElement.scrollWidth
        const captureHeight = captureElement.scrollHeight
        const maxScale = Math.sqrt(MAX_EXPORT_PIXELS / Math.max(1, captureWidth * captureHeight))
        const scale = Math.min(SHARE_EXPORT_SCALE, maxScale)
        canvas = await html2canvas(captureElement, {
            backgroundColor: getComputedStyle(captureElement).backgroundColor || '#ffffff',
            foreignObjectRendering: false,
            imageTimeout: 15000,
            logging: false,
            removeContainer: true,
            scale,
            useCORS: true,
            width: captureWidth,
            height: captureHeight,
            windowWidth: Math.max(SHARE_EXPORT_WIDTH, captureWidth),
            windowHeight: Math.max(document.documentElement.clientHeight, captureHeight),
        })
    } finally {
        frame.remove()
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Failed to encode shared image')
    return blob
}

async function copyImageBlob(blob: Blob): Promise<void> {
    const ClipboardItemCtor = window.ClipboardItem
    if (!navigator.clipboard?.write || !ClipboardItemCtor) {
        throw new Error('Image clipboard is not supported in this browser')
    }
    await navigator.clipboard.write([
        new ClipboardItemCtor({ [blob.type]: blob })
    ])
}

function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function shareImageBlob(blob: Blob): Promise<void> {
    const file = new File([blob], getShareFileName(), { type: blob.type })
    if (!navigator.share) {
        throw new Error('Image sharing is not supported in this browser')
    }
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'HAPI shared turn' })
        return
    }
    throw new Error('File sharing is not supported in this browser')
}

export function ShareTurnDialog(props: ShareTurnDialogProps) {
    const { t } = useTranslation()
    const captureRef = useRef<HTMLDivElement | null>(null)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const [busy, setBusy] = useState<'copy' | 'download' | 'share' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [restoreTick, setRestoreTick] = useState(0)
    const [ready, setReady] = useState(false)
    const showNativeShareButton = true

    useLayoutEffect(() => {
        setReady(false)
        if (!props.isOpen) return undefined
        const body = bodyRef.current
        if (!body) {
            const frame = window.requestAnimationFrame(() => {
                setRestoreTick((tick) => tick + 1)
            })
            return () => window.cancelAnimationFrame(frame)
        }
        body.replaceChildren()

        const fragment = document.createDocumentFragment()
        let textLength = 0
        for (const snapshot of props.sourceSnapshots) {
            const template = document.createElement('template')
            template.innerHTML = snapshot.html
            textLength += snapshot.text.length
            let appendedSnapshot = false
            for (const node of Array.from(template.content.children)) {
                if (!(node instanceof HTMLElement)) continue
                node.removeAttribute('id')
                node.classList.remove('scroll-mt-4')
                if (node.matches('[data-hapi-share-exclude="true"]')) continue
                stripCaptureOnlyControls(node)
                if ((node.innerText || node.textContent || '').trim().length === 0 && node.querySelector('img, video, canvas, svg') == null) continue
                fragment.appendChild(node)
                appendedSnapshot = true
            }
            if (!appendedSnapshot) appendTextFallback(fragment, snapshot)
        }
        body.replaceChildren(fragment)

        if ((body.innerText || body.textContent || '').trim().length === 0 && textLength > 0) {
            for (const snapshot of props.sourceSnapshots) {
                appendTextFallback(body, snapshot)
            }
        }
        setReady(true)

        setError(null)
        setCopied(false)
        return undefined
    }, [props.isOpen, props.sourceSnapshots, restoreTick])

    const withPng = async (action: (blob: Blob) => Promise<void> | void, mode: 'copy' | 'download' | 'share') => {
        const capture = captureRef.current
        if (!capture || !ready) return
        setBusy(mode)
        setError(null)
        try {
            const blob = await elementToPngBlob(capture)
            await action(blob)
            if (mode === 'copy') {
                setCopied(true)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create image')
        } finally {
            setBusy(null)
        }
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent className="max-h-[calc(100vh-24px)] max-w-3xl overflow-hidden p-4" aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>{t('shareTurn.title')}</DialogTitle>
                </DialogHeader>

                <div className="mt-3 max-h-[58vh] overflow-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2 sm:max-h-[65vh] sm:p-3">
                    <div
                        ref={captureRef}
                        className="mx-auto w-[720px] max-w-full rounded-[28px] bg-[var(--app-bg)] p-4 text-[var(--app-fg)] sm:p-5"
                    >
                        <div className="mb-4 flex items-start justify-between gap-3 border-b border-[var(--app-divider)] pb-3">
                            <div className="min-w-0">
                                <div className="text-lg font-semibold">HAPI</div>
                                <div className="mt-1 truncate text-xs text-[var(--app-hint)]">{props.title}</div>
                                <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">{props.subtitle}</div>
                            </div>
                            <div className="rounded-full border border-[var(--app-border)] px-2 py-1 text-[10px] text-[var(--app-hint)]">
                                {t('shareTurn.badge')}
                            </div>
                        </div>
                        <div ref={bodyRef} data-hapi-share-body="true" className="flex flex-col gap-3" />
                        <div className="mt-4 border-t border-[var(--app-divider)] pt-3 text-[10px] text-[var(--app-hint)]">
                            {t('shareTurn.generated')}
                        </div>
                    </div>
                </div>

                {error ? (
                    <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div>
                ) : null}

                <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                    <button
                        type="button"
                        onClick={props.onClose}
                        className="rounded-md border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] sm:w-32"
                    >
                        {t('shareTurn.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => { void withPng(copyImageBlob, 'copy') }}
                        disabled={busy !== null || !ready}
                        className="hidden rounded-md border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 sm:inline-block sm:w-32"
                    >
                        {busy === 'copy' ? t('shareTurn.copying') : copied ? t('shareTurn.copied') : t('shareTurn.copy')}
                    </button>
                    {showNativeShareButton ? (
                        <button
                            type="button"
                            onClick={() => { void withPng(shareImageBlob, 'share') }}
                            disabled={busy !== null || !ready}
                            className="rounded-md border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 sm:w-32"
                        >
                            {busy === 'share' ? t('shareTurn.sharing') : t('shareTurn.share')}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => {
                            void withPng((blob) => downloadBlob(blob, getShareFileName()), 'download')
                        }}
                        disabled={busy !== null || !ready}
                        className="col-span-2 rounded-md bg-[var(--app-button)] px-3 py-2 text-sm text-[var(--app-button-text)] disabled:opacity-50 sm:col-span-1 sm:w-32"
                    >
                        {busy === 'download' ? t('shareTurn.saving') : t('shareTurn.download')}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
