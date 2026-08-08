import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { ZoomableLightbox } from '@/components/ZoomableLightbox'
import { safeCopyToClipboard } from '@/lib/clipboard'
import type { ShareTurnMetadataItem } from '@/lib/shareTurnMetadata'

type ShareTurnDialogProps = {
    isOpen: boolean
    title: string
    metadataItems: ShareTurnMetadataItem[]
    sourceSnapshots: Array<{
        html: string
        text: string
        role?: 'user' | 'assistant'
    }>
    sourceContentWidth?: number | null
    onClose: () => void
}

type ShareTurnSnapshot = ShareTurnDialogProps['sourceSnapshots'][number]

const SHARE_EXPORT_WIDTH = 960
const SHARE_EXPORT_HORIZONTAL_PADDING = 40
const SHARE_EXPORT_SCALE = 2
const MAX_EXPORT_PIXELS = 24_000_000
const SHARE_HIDDEN_CONTENT_SELECTOR = '[data-hapi-share-exclude="true"], .aui-reasoning-group'

function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        window.requestAnimationFrame(() => resolve())
    })
}

function stripCaptureOnlyControls(root: HTMLElement): void {
    for (const element of Array.from(root.querySelectorAll(SHARE_HIDDEN_CONTENT_SELECTOR))) {
        if (!(element instanceof HTMLElement) || !root.contains(element)) continue

        let previous = element.previousElementSibling
        while (previous?.matches(SHARE_HIDDEN_CONTENT_SELECTOR)) previous = previous.previousElementSibling
        let next = element.nextElementSibling
        while (next?.matches(SHARE_HIDDEN_CONTENT_SELECTOR)) next = next.nextElementSibling

        const separatesVisibleContent = previous != null
            && next != null
            && !previous.matches('.hapi-share-hidden-content-spacer')
        if (separatesVisibleContent) {
            const spacer = document.createElement('div')
            spacer.className = 'hapi-share-hidden-content-spacer'
            spacer.setAttribute('aria-hidden', 'true')
            element.replaceWith(spacer)
        } else {
            element.remove()
        }
    }
    for (const element of Array.from(root.querySelectorAll('.happy-message-actions, .happy-message-actions-first-line, [data-hapi-share-action="true"], button[aria-expanded], input, textarea, select'))) {
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

function stripExportControls(root: HTMLElement): void {
    for (const element of Array.from(root.querySelectorAll('[data-hapi-share-export-exclude="true"]'))) {
        element.remove()
    }
    for (const imageButton of Array.from(root.querySelectorAll('button:has(img)'))) {
        imageButton.removeAttribute('title')
        imageButton.removeAttribute('aria-label')
        imageButton.setAttribute('tabindex', '-1')
    }
}

function getPreviewCodeBody(control: HTMLElement): HTMLElement | null {
    const block = control.closest<HTMLElement>('[data-hapi-code-block="true"]')
    if (block) return block.querySelector<HTMLElement>('[data-hapi-code-body="true"]')
    const header = control.closest<HTMLElement>('[data-hapi-code-header="true"]')
    const body = header?.nextElementSibling
    return body instanceof HTMLElement && body.matches('[data-hapi-code-body="true"]') ? body : null
}

function setPreviewCodeWrap(control: HTMLElement, enabled: boolean): void {
    const body = getPreviewCodeBody(control)
    const grid = body?.querySelector<HTMLElement>('[data-hapi-code-grid="true"]')
    if (!body || !grid) return

    body.classList.toggle('overflow-x-auto', !enabled)
    grid.classList.toggle('w-full', enabled)
    grid.classList.toggle('w-max', !enabled)
    grid.classList.toggle('min-w-full', !enabled)
    grid.style.gridTemplateColumns = enabled
        ? grid.style.gridTemplateColumns.replace(/max-content\s*$/, 'minmax(0, 1fr)')
        : grid.style.gridTemplateColumns.replace(/minmax\(0,\s*1fr\)\s*$/, 'max-content')
    grid.style.whiteSpace = enabled ? 'pre-wrap' : 'pre'
    grid.style.wordBreak = enabled ? 'break-word' : ''
    for (const cell of Array.from(grid.querySelectorAll<HTMLElement>('[data-code-cell]'))) {
        cell.style.whiteSpace = enabled ? 'pre-wrap' : 'pre'
        cell.style.wordBreak = enabled ? 'break-word' : ''
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

function sanitizeShareFileNamePart(title: string): string {
    const withoutControlCharacters = Array.from(title.normalize('NFKC'))
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0
            return codePoint >= 32 && codePoint !== 127
        })
        .join('')
    const sanitized = withoutControlCharacters
        .replace(/[<>:"/\\|?*]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .replace(/^[ .-]+|[ .-]+$/g, '')
        .trim()
    return Array.from(sanitized || 'Shared turn').slice(0, 80).join('').trim()
}

function getShareFileName(title: string): string {
    return `HAPI-${sanitizeShareFileNamePart(title)}-${formatShareTimestamp()}.png`
}

function prepareExportElement(element: HTMLElement, exportWidth: number, preserveSourceLayout: boolean): HTMLElement {
    const captureElement = element.cloneNode(true)
    if (!(captureElement instanceof HTMLElement)) {
        throw new Error('Failed to prepare shared image')
    }

    for (const code of Array.from(captureElement.querySelectorAll<HTMLElement>('code'))) {
        if (code.closest('pre')) continue
        const textWrapper = document.createElement('span')
        textWrapper.dataset.hapiInlineCodeText = 'true'
        while (code.firstChild) textWrapper.appendChild(code.firstChild)
        code.appendChild(textWrapper)
    }

    const elementStyle = getComputedStyle(element)
    const backgroundColor = elementStyle.backgroundColor && elementStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? elementStyle.backgroundColor
        : (getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim() || '#ffffff')
    const color = elementStyle.color || getComputedStyle(document.documentElement).getPropertyValue('--app-fg').trim() || '#111827'

    captureElement.classList.add('hapi-share-export-root')
    stripExportControls(captureElement)
    captureElement.style.cssText += [
        'position:absolute',
        'left:0',
        'top:0',
        'z-index:-1',
        `width:${exportWidth}px`,
        `max-width:${exportWidth}px`,
        'box-sizing:border-box',
        'transform:none',
        'zoom:1',
        'pointer-events:none',
        'overflow:visible',
        '-webkit-text-size-adjust:100%',
        'text-size-adjust:100%',
        ...(preserveSourceLayout ? [] : ['font-size:14px', 'line-height:1.6']),
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
            ${preserveSourceLayout ? '' : `
                font-size: 14px !important;
                line-height: 1.6 !important;
            `}
        }
        .hapi-share-export-root [data-hapi-share-exclude="true"],
        .hapi-share-export-root .aui-reasoning-group,
        .hapi-share-export-root button[aria-expanded],
        .hapi-share-export-root [data-hapi-share-export-exclude="true"] {
            display: none !important;
        }
        .hapi-share-export-root,
        .hapi-share-export-root * {
            /* html2canvas-pro renders non-zero letter spacing one grapheme at
               a time and switches CJK glyphs to an ideographic baseline.
               Mixed CJK/Latin text then no longer shares the browser's single
               shaped baseline. Zero spacing keeps each text run intact. */
            letter-spacing: 0 !important;
        }
        .hapi-share-export-root :not(pre) > code {
            position: relative !important;
            /* html2canvas-pro paints an inline element's background using its
               full inherited line box. Collapse the code element's own line
               box to its em square so the existing block padding produces the
               same pill height as the browser for both message roles. */
            line-height: 1em !important;
        }
        .hapi-share-export-root [data-hapi-inline-code-text="true"] {
            /* Move only the monospace glyphs. Keep the inline-code border and
               background in the same position as the browser layout. */
            position: relative !important;
            top: -1px !important;
        }
        ${preserveSourceLayout ? '' : `
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
        `}
        .hapi-share-export-root .sr-only {
            display: none !important;
        }
        .hapi-share-export-root .hapi-share-hidden-content-spacer {
            display: block !important;
            height: 0.75rem !important;
        }
        .hapi-share-export-root [data-hapi-code-body="true"] {
            scrollbar-width: none !important;
        }
        .hapi-share-export-root [data-hapi-code-body="true"]::-webkit-scrollbar {
            display: none !important;
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

async function elementToPngBlob(
    element: HTMLElement,
    exportWidth: number,
    preserveSourceLayout: boolean
): Promise<Blob> {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = [
        'position:fixed',
        'left:-10000px',
        'top:0',
        `width:${exportWidth}px`,
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
        `width:${exportWidth}px`,
        'min-height:1000px',
        'overflow:visible',
        'background:transparent'
    ].join(';'))

    const base = frameDocument.createElement('base')
    base.href = document.baseURI
    frameDocument.head.appendChild(base)

    copyLoadedStyleSheets(document, frameDocument)

    const captureElement = prepareExportElement(element, exportWidth, preserveSourceLayout)
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
        const backgroundColor = getComputedStyle(captureElement).backgroundColor || '#ffffff'
        const { default: html2canvas } = await import('html2canvas-pro')
        canvas = await html2canvas(captureElement, {
            backgroundColor,
            foreignObjectRendering: false,
            imageTimeout: 15000,
            logging: false,
            removeContainer: true,
            scale,
            useCORS: true,
            width: captureWidth,
            height: captureHeight,
            windowWidth: Math.max(exportWidth, captureWidth),
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

async function shareImageBlob(blob: Blob, fileName: string): Promise<void> {
    const file = new File([blob], fileName, { type: blob.type })
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
    const [preparedBlob, setPreparedBlob] = useState<Blob | null>(null)
    const [previewRevision, setPreviewRevision] = useState(0)
    const [previewImage, setPreviewImage] = useState<{
        src: string
        label: string
        naturalWidth: number
        naturalHeight: number
    } | null>(null)
    const showNativeShareButton = true
    const usesCoarsePrimaryPointer = window.matchMedia('(pointer: coarse)').matches
    const preserveSourceLayout = Boolean(
        props.sourceContentWidth
        && props.sourceContentWidth > 0
        && window.matchMedia('(min-width: 640px)').matches
        && !usesCoarsePrimaryPointer
    )
    const exportWidth = preserveSourceLayout
        ? Math.min(1240, Math.max(480, Math.ceil((props.sourceContentWidth ?? 0) + SHARE_EXPORT_HORIZONTAL_PADDING)))
        : SHARE_EXPORT_WIDTH

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
            const isTextOnlySnapshot = snapshot.html.trim().length === 0
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
            if (!appendedSnapshot && isTextOnlySnapshot) appendTextFallback(fragment, snapshot)
        }
        body.replaceChildren(fragment)

        if ((body.innerText || body.textContent || '').trim().length === 0 && textLength > 0) {
            for (const snapshot of props.sourceSnapshots) {
                if (snapshot.html.trim().length === 0) appendTextFallback(body, snapshot)
            }
        }
        setReady(true)

        setError(null)
        setCopied(false)
        setPreviewImage(null)
        return undefined
    }, [props.isOpen, props.sourceSnapshots, restoreTick])

    useEffect(() => {
        const capture = captureRef.current
        if (!props.isOpen || !ready || !capture) {
            setPreparedBlob(null)
            return undefined
        }

        let cancelled = false
        setPreparedBlob(null)
        void elementToPngBlob(capture, exportWidth, preserveSourceLayout).then((blob) => {
            if (!cancelled) setPreparedBlob(blob)
        }).catch((err) => {
            if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to create image')
        })
        return () => {
            cancelled = true
        }
    }, [props.isOpen, props.title, props.sourceSnapshots, props.metadataItems, ready, restoreTick, previewRevision, exportWidth, preserveSourceLayout])

    const handlePreviewClick = (event: ReactMouseEvent<HTMLElement>) => {
        const target = event.target
        if (!(target instanceof Element)) return

        const wrapButton = target.closest<HTMLButtonElement>('[data-hapi-code-wrap-toggle="true"]')
        if (wrapButton) {
            event.preventDefault()
            event.stopPropagation()
            if (!getPreviewCodeBody(wrapButton)) return
            const enabled = wrapButton.getAttribute('aria-pressed') !== 'true'
            wrapButton.setAttribute('aria-pressed', String(enabled))
            wrapButton.title = enabled
                ? (wrapButton.dataset.hapiWrapDisableLabel ?? '')
                : (wrapButton.dataset.hapiWrapEnableLabel ?? '')
            setPreviewCodeWrap(wrapButton, enabled)
            setPreparedBlob(null)
            setPreviewRevision((revision) => revision + 1)
            return
        }

        const copyButton = target.closest<HTMLButtonElement>('[data-hapi-code-copy="true"]')
        if (copyButton) {
            event.preventDefault()
            event.stopPropagation()
            const body = getPreviewCodeBody(copyButton)
            const cells = Array.from(body?.querySelectorAll<HTMLElement>('[data-code-cell]') ?? [])
            const code = (cells.length > 0
                ? cells.map((cell) => cell.textContent ?? '').join('\n')
                : body?.querySelector('pre')?.textContent ?? '')
            if (!code) return
            void safeCopyToClipboard(code).then(() => {
                copyButton.querySelector('[data-hapi-copy-default="true"]')?.classList.add('hidden')
                copyButton.querySelector('[data-hapi-copy-success="true"]')?.classList.remove('hidden')
                copyButton.title = copyButton.dataset.hapiCopiedLabel ?? copyButton.title
                window.setTimeout(() => {
                    if (!copyButton.isConnected) return
                    copyButton.querySelector('[data-hapi-copy-default="true"]')?.classList.remove('hidden')
                    copyButton.querySelector('[data-hapi-copy-success="true"]')?.classList.add('hidden')
                    copyButton.title = copyButton.dataset.hapiCopyLabel ?? copyButton.title
                }, 1500)
            }).catch(() => undefined)
            return
        }

        const imageButton = target.closest<HTMLButtonElement>('[data-image-preview-trigger]')
        const image = imageButton?.querySelector<HTMLImageElement>('img')
        if (image) {
            event.preventDefault()
            event.stopPropagation()
            setPreviewImage({
                src: image.currentSrc || image.src,
                label: image.alt || imageButton?.dataset.imagePreviewLabel || 'Image preview',
                naturalWidth: image.naturalWidth || image.width,
                naturalHeight: image.naturalHeight || image.height
            })
        }
    }

    const runBlobAction = (
        blob: Blob,
        action: (prepared: Blob) => Promise<void> | void,
        mode: 'copy' | 'download' | 'share'
    ) => {
        // Invoke the action before yielding so navigator.share() stays in the
        // direct click activation window. PNG rendering happens eagerly above.
        setBusy(mode)
        setError(null)
        let result: Promise<void> | void
        try {
            result = action(blob)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create image')
            setBusy(null)
            return
        }
        void Promise.resolve(result).then(() => {
            if (mode === 'copy') setCopied(true)
        }).catch((err) => {
            setError(err instanceof Error ? err.message : 'Failed to create image')
        }).finally(() => {
            setBusy(null)
        })
    }

    const withPng = async (action: (blob: Blob) => Promise<void> | void, mode: 'copy' | 'download') => {
        if (preparedBlob) {
            runBlobAction(preparedBlob, action, mode)
            return
        }
        const capture = captureRef.current
        if (!capture || !ready) return
        setBusy(mode)
        setError(null)
        try {
            const blob = await elementToPngBlob(capture, exportWidth, preserveSourceLayout)
            await action(blob)
            if (mode === 'copy') setCopied(true)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create image')
        } finally {
            setBusy(null)
        }
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent
                className="max-h-[calc(100vh-24px)] max-w-3xl overflow-hidden p-4 [&>button:last-child]:top-4"
                aria-describedby={undefined}
            >
                <DialogHeader className="h-8 justify-center !px-10 text-center sm:text-center">
                    <DialogTitle>{t('shareTurn.title')}</DialogTitle>
                </DialogHeader>

                <div className="mt-3 max-h-[58vh] overflow-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2 sm:max-h-[65vh] sm:p-3">
                    <div
                        ref={captureRef}
                        onClick={handlePreviewClick}
                        className="hapi-share-preview-root mx-auto w-[720px] max-w-full rounded-[28px] bg-[var(--app-bg)] p-4 text-[var(--app-fg)] sm:p-5"
                    >
                        <style>{`
                            .hapi-share-preview-root .hapi-share-hidden-content-spacer {
                                display: block !important;
                                height: 0.75rem !important;
                            }
                            .hapi-share-preview-root .hapi-share-media-grid[data-hapi-image-count="2"] {
                                flex-wrap: nowrap !important;
                            }
                            .hapi-share-preview-root .hapi-share-media-grid > button {
                                height: auto !important;
                                align-self: start !important;
                                flex-shrink: 1 !important;
                                min-width: 0 !important;
                                cursor: zoom-in !important;
                                pointer-events: auto !important;
                            }
                            .hapi-share-preview-root .hapi-share-media-grid > button > img {
                                width: auto !important;
                                max-width: 100% !important;
                                height: auto !important;
                            }
                        `}</style>
                        <div className="mb-4 border-b border-[var(--app-divider)] pb-3">
                            <div className="min-w-0">
                                <div className="truncate text-lg font-semibold">{props.title}</div>
                                {props.metadataItems.length > 0 ? (
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--app-hint)]">
                                        {props.metadataItems.map((item) => item.key === 'agent' ? (
                                            <span key={item.key} className="inline-flex items-center gap-1">
                                                <AgentFlavorIcon flavor={item.flavor} className="h-3.5 w-3.5 shrink-0" />
                                                {item.text}
                                            </span>
                                        ) : (
                                            <span key={item.key} className={item.key === 'fastMode' ? 'text-[#34C759]' : undefined}>
                                                {item.text}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                        <div ref={bodyRef} data-hapi-share-body="true" className="flex flex-col gap-3" />
                        <div className="mt-4 border-t border-[var(--app-divider)] pt-3 text-[10px] text-[var(--app-hint)]">
                            {t('shareTurn.generated')}
                        </div>
                    </div>
                </div>
                {previewImage ? (
                    <ZoomableLightbox
                        open
                        onClose={() => setPreviewImage(null)}
                        title={previewImage.label}
                        ariaLabel={previewImage.label}
                        fitContentKey={previewImage.src}
                        fitContentSize={previewImage.naturalWidth > 0 && previewImage.naturalHeight > 0
                            ? { width: previewImage.naturalWidth, height: previewImage.naturalHeight }
                            : null}
                    >
                        <img
                            src={previewImage.src}
                            alt={previewImage.label}
                            width={previewImage.naturalWidth || undefined}
                            height={previewImage.naturalHeight || undefined}
                            className="block max-w-none select-none object-contain"
                            draggable={false}
                        />
                    </ZoomableLightbox>
                ) : null}

                {error ? (
                    <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div>
                ) : null}

                <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                    <button
                        type="button"
                        onClick={() => { void withPng(copyImageBlob, 'copy') }}
                        disabled={busy !== null || !ready}
                        className="hidden rounded-md border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 sm:inline-block sm:w-32"
                    >
                        {copied ? t('shareTurn.copied') : t('shareTurn.copy')}
                    </button>
                    {showNativeShareButton ? (
                        <button
                            type="button"
                            onClick={() => {
                                if (preparedBlob) {
                                    runBlobAction(
                                        preparedBlob,
                                        (blob) => shareImageBlob(blob, getShareFileName(props.title)),
                                        'share'
                                    )
                                }
                            }}
                            disabled={busy !== null || !preparedBlob}
                            className="rounded-md border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 sm:w-32"
                        >
                            {busy === 'share' ? t('shareTurn.sharing') : t('shareTurn.share')}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => {
                            void withPng((blob) => downloadBlob(blob, getShareFileName(props.title)), 'download')
                        }}
                        disabled={busy !== null || !ready}
                        className="rounded-md bg-[var(--app-button)] px-3 py-2 text-sm text-[var(--app-button-text)] disabled:opacity-50 sm:w-32"
                    >
                        {busy === 'download' ? t('shareTurn.saving') : t('shareTurn.download')}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
