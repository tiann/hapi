import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
    type RefObject,
    type ReactNode,
} from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CloseIcon, CopyIcon, WrapIcon } from '@/components/icons'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { Spinner } from '@/components/Spinner'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { getShareImageFileName, getShareTableFileName } from '@/lib/share-image-filename'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

type TableProps = ComponentPropsWithoutRef<'table'>

type IconProps = {
    className?: string
}

type TableOrientationApi = {
    lock?: (orientation: 'landscape') => Promise<void>
    unlock?: () => void
}

function ExpandIcon(props: IconProps) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" />
            <path d="m3 3 6 6M21 3l-6 6M3 21l6-6M21 21l-6-6" />
        </svg>
    )
}

function DownloadIcon(props: IconProps) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
        </svg>
    )
}

function TableActionButton(props: {
    label: string
    onClick: () => void
    children: ReactNode
    variant?: 'surface' | 'ghost'
}) {
    const variantClassName = props.variant === 'ghost'
        ? 'border-0 bg-transparent text-[var(--app-hint)] shadow-none hover:text-[var(--app-fg)]'
        : 'border border-[var(--app-border)] bg-[var(--app-md-table-bg)]/90 text-[var(--app-hint)] shadow-sm hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'

    return (
        <button
            type="button"
            aria-label={props.label}
            title={props.label}
            onClick={props.onClick}
            className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                variantClassName,
            )}
        >
            {props.children}
        </button>
    )
}

function isCoarsePointerDevice(): boolean {
    if (typeof window === 'undefined') return false

    const coarsePointer = window.matchMedia('(pointer: coarse)').matches
    const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    const desktopModeIpad = /Macintosh/i.test(userAgent) && touchPoints > 1

    return coarsePointer || mobileUserAgent || desktopModeIpad
}

function TableActionMenu(props: {
    label: string
    children: ReactNode
    tabIndex?: number
    items: Array<{
        label: string
        onSelect: () => void
        disabled?: boolean
    }>
}) {
    const [open, setOpen] = useState(false)
    const closeTimerRef = useRef<number | null>(null)
    const hoverOpenedRef = useRef(false)

    const clearCloseTimer = useCallback(() => {
        if (closeTimerRef.current == null) return
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
    }, [])

    const scheduleClose = useCallback(() => {
        clearCloseTimer()
        closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null
            setOpen(false)
        }, 140)
    }, [clearCloseTimer])

    useEffect(() => () => clearCloseTimer(), [clearCloseTimer])

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <div
                className="shrink-0"
                onMouseEnter={clearCloseTimer}
                onMouseLeave={scheduleClose}
            >
                <Popover.Trigger asChild>
                    <button
                        type="button"
                        data-hapi-table-viewer-control="true"
                        aria-label={props.label}
                        title={props.label}
                        tabIndex={props.tabIndex}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onMouseEnter={() => {
                            hoverOpenedRef.current = true
                            clearCloseTimer()
                            setOpen(true)
                        }}
                        onPointerDown={(event) => {
                            if (!hoverOpenedRef.current) return

                            hoverOpenedRef.current = false
                            if (!open || event.button !== 0 || event.ctrlKey) return

                            event.currentTarget.focus()
                            event.preventDefault()
                        }}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        {props.children}
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        side="bottom"
                        align="end"
                        sideOffset={4}
                        collisionPadding={8}
                        onMouseEnter={clearCloseTimer}
                        onMouseLeave={scheduleClose}
                        className="z-[60] w-max min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg"
                    >
                        <div role="menu" aria-label={props.label} className="flex w-max flex-col gap-0.5">
                            {props.items.map((item) => (
                                <button
                                    key={item.label}
                                    type="button"
                                    role="menuitem"
                                    disabled={item.disabled}
                                    onClick={() => {
                                        hoverOpenedRef.current = false
                                        setOpen(false)
                                        item.onSelect()
                                    }}
                                    className="w-full whitespace-nowrap rounded px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-wait disabled:opacity-50"
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </Popover.Content>
                </Popover.Portal>
            </div>
        </Popover.Root>
    )
}

/** Exported for responsive behavior tests and future table viewers. */
export function isMobileTableViewerViewport(): boolean {
    if (typeof window === 'undefined') return false
    const shortSide = Math.min(window.innerWidth, window.innerHeight)
    return shortSide <= 767 && isCoarsePointerDevice()
}

function getTableCellText(cell: HTMLTableCellElement): string {
    const innerText = cell.innerText
    const text = typeof innerText === 'string' ? innerText : cell.textContent ?? ''
    return text.replace(/\s+/g, ' ').trim()
}

function escapeCsvCell(value: string): string {
    const safeValue = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value
    return `"${safeValue.replace(/"/g, '""')}"`
}

export function serializeTableToCsv(table: HTMLTableElement): string {
    const rows = Array.from(table.rows).map((row) =>
        Array.from(row.cells).map((cell) => escapeCsvCell(getTableCellText(cell))).join(','),
    )

    return rows.length > 0 ? `\uFEFF${rows.join('\r\n')}\r\n` : '\uFEFF'
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function serializeMarkdownText(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/([&`*_\[\]<>~])/g, '\\$1')
}

function serializeMarkdownDestination(value: string): string {
    const escaped = value.replace(/[\\<>&]/g, '\\$&')
    return /[\s()]/.test(value) || escaped !== value ? `<${escaped}>` : escaped
}

function serializeInlineMarkdown(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return serializeMarkdownText(node.textContent ?? '')
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return Array.from(node.childNodes, serializeInlineMarkdown).join('')
    }

    const element = node as HTMLElement
    const children = () => Array.from(element.childNodes, serializeInlineMarkdown).join('')
    switch (element.tagName.toLowerCase()) {
        case 'a': {
            const href = element.dataset.hapiMarkdownHref ?? element.getAttribute('href')
            const label = children()
            if (href?.startsWith('hapi-file:') || href?.startsWith('hapi-file-candidate:')) return label
            return href ? `[${label}](${serializeMarkdownDestination(href)})` : label
        }
        case 'code':
            return serializeCodeSpan(element.textContent ?? '')
        case 'strong':
        case 'b':
            return `**${children()}**`
        case 'em':
        case 'i':
            return `*${children()}*`
        case 'del':
        case 's':
            return `~~${children()}~~`
        case 'br':
            return ' '
        case 'img': {
            const src = element.getAttribute('src')
            const alt = serializeMarkdownText(element.getAttribute('alt') ?? '')
            return src ? `![${alt}](${serializeMarkdownDestination(src)})` : alt
        }
        case 'span': {
            const href = element.dataset.hapiMarkdownHref
            return href ? `[${children()}](${serializeMarkdownDestination(href)})` : children()
        }
        default:
            return children()
    }
}

function serializeCodeSpan(value: string): string {
    const longestRun = Math.max(
        0,
        ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
    )
    const fence = '`'.repeat(longestRun + 1)
    const needsPadding = value.startsWith('`')
        || value.endsWith('`')
        || (value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0)
    const padding = needsPadding ? ' ' : ''
    return `${fence}${padding}${value}${padding}${fence}`
}

function getTableCellMarkdown(cell: HTMLTableCellElement): string {
    return Array.from(cell.childNodes, serializeInlineMarkdown)
        .join('')
        .trim()
}

function formatMarkdownTableRow(cells: string[], width: number): string {
    const padded = [...cells, ...Array.from({ length: Math.max(0, width - cells.length) }, () => '')]
    return `| ${padded.map(escapeMarkdownTableCell).join(' | ')} |`
}

function getTableCellAlignment(cell: HTMLTableCellElement | undefined): 'left' | 'center' | 'right' | undefined {
    const alignment = cell?.getAttribute('align') ?? cell?.style.textAlign
    if (alignment === 'left' || alignment === 'center' || alignment === 'right') return alignment
    return undefined
}

function formatMarkdownAlignment(alignment: 'left' | 'center' | 'right' | undefined): string {
    if (alignment === 'left') return ':---'
    if (alignment === 'center') return ':---:'
    if (alignment === 'right') return '---:'
    return '---'
}

export function serializeTableToMarkdown(table: HTMLTableElement): string {
    const rows = Array.from(table.rows).map((row) =>
        Array.from(row.cells).map(getTableCellMarkdown),
    )
    if (rows.length === 0) return ''

    const width = Math.max(...rows.map((row) => row.length), 1)
    const header = rows[0] ?? []
    const headerCells = Array.from(table.tHead?.rows[0]?.cells ?? table.rows[0]?.cells ?? [])
    const separator = Array.from({ length: width }, (_, index) => formatMarkdownAlignment(getTableCellAlignment(headerCells[index])))
    return [
        formatMarkdownTableRow(header, width),
        formatMarkdownTableRow(separator, width),
        ...rows.slice(1).map((row) => formatMarkdownTableRow(row, width)),
    ].join('\n') + '\n'
}

const TABLE_WRAP_PREFERENCE_PREFIX = 'hapi-table-wrap:v1'

function hashTableWrapIdentity(value: string): string {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getTableWrapPreferenceKey(table: HTMLTableElement, scope = 'Table'): string {
    const identity = `${scope.trim() || 'Table'}\n${serializeTableToMarkdown(table)}`
    return `${TABLE_WRAP_PREFERENCE_PREFIX}:${hashTableWrapIdentity(identity)}`
}

export function shouldWrapTableByDefault(table: HTMLTableElement, viewer: HTMLElement): boolean {
    const wrappedValue = table.getAttribute('data-hapi-table-wrap')
    if (wrappedValue === null) return table.scrollWidth > viewer.clientWidth + 1

    table.removeAttribute('data-hapi-table-wrap')
    try {
        return table.scrollWidth > viewer.clientWidth + 1
    } finally {
        table.setAttribute('data-hapi-table-wrap', wrappedValue)
    }
}

function readTableWrapPreference(key: string | undefined): boolean | null {
    if (!key || typeof window === 'undefined') return null
    try {
        const value = window.localStorage.getItem(key)
        if (value === '1') return true
        if (value === '0') return false
    } catch {
        // Private browsing and blocked storage should not affect the viewer.
    }
    return null
}

function writeTableWrapPreference(key: string | undefined, value: boolean): void {
    if (!key || typeof window === 'undefined') return
    try {
        window.localStorage.setItem(key, value ? '1' : '0')
    } catch {
        // Ignore storage quota and privacy-mode failures.
    }
}

export function downloadTableAsCsv(table: HTMLTableElement, filename = 'hapi-table.csv'): void {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return

    const blob = new Blob([serializeTableToCsv(table)], { type: 'text/csv;charset=utf-8' })
    downloadBlob(blob, filename)
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Match the working session-image download path. Some mobile browsers
    // read a Blob URL asynchronously after click; revoking it immediately
    // makes the download appear to do nothing.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const TABLE_IMAGE_STYLE_PROPERTIES = [
    'background-color',
    'border-bottom-color',
    'border-bottom-style',
    'border-bottom-width',
    'border-collapse',
    'border-left-color',
    'border-left-style',
    'border-left-width',
    'border-right-color',
    'border-right-style',
    'border-right-width',
    'border-spacing',
    'border-top-color',
    'border-top-style',
    'border-top-width',
    'box-sizing',
    'color',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'letter-spacing',
    'line-height',
    'overflow-wrap',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'padding-top',
    'text-align',
    'text-decoration',
    'text-transform',
    'vertical-align',
    'white-space',
    'word-break',
] as const

function copyTableImageStyles(source: HTMLTableElement, clone: HTMLTableElement): void {
    const sourceElements = [source, ...Array.from(source.querySelectorAll('*'))]
    const cloneElements = [clone, ...Array.from(clone.querySelectorAll('*'))]

    sourceElements.forEach((sourceElement, index) => {
        const cloneElement = cloneElements[index]
        if (!cloneElement) return
        const cloneStyle = (cloneElement as Element & { style?: CSSStyleDeclaration }).style
        if (!cloneStyle) return
        const computedStyle = getComputedStyle(sourceElement)
        for (const property of TABLE_IMAGE_STYLE_PROPERTIES) {
            cloneStyle.setProperty(property, computedStyle.getPropertyValue(property), 'important')
        }
    })
}

function getTableColumnWidths(table: HTMLTableElement): number[] {
    const widths: number[] = []
    for (const row of Array.from(table.rows)) {
        let columnIndex = 0
        for (const cell of Array.from(row.cells)) {
            const span = Math.max(1, cell.colSpan || 1)
            const cellWidth = cell.getBoundingClientRect().width
            if (cellWidth > 0 && Number.isFinite(cellWidth)) {
                const columnWidth = cellWidth / span
                for (let offset = 0; offset < span; offset += 1) {
                    const index = columnIndex + offset
                    widths[index] = Math.max(widths[index] ?? 0, columnWidth)
                }
            }
            columnIndex += span
        }
    }
    return widths
}

function applyTableImageColumnWidths(table: HTMLTableElement, clone: HTMLTableElement, tableWidth: number): void {
    const measuredWidths = getTableColumnWidths(table)
    const totalMeasuredWidth = measuredWidths.reduce((total, width) => total + width, 0)
    if (measuredWidths.length === 0 || totalMeasuredWidth <= 0) return

    const widthScale = tableWidth / totalMeasuredWidth
    const colgroup = document.createElement('colgroup')
    for (const measuredWidth of measuredWidths) {
        const col = document.createElement('col')
        col.style.width = `${measuredWidth * widthScale}px`
        colgroup.appendChild(col)
    }
    clone.querySelectorAll(':scope > colgroup').forEach((existing) => existing.remove())
    clone.insertBefore(colgroup, clone.firstChild)
    clone.style.setProperty('table-layout', 'fixed', 'important')
}

function isTransparentColor(value: string): boolean {
    return value === '' || value === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/i.test(value)
}

function getTableHeaderBackground(table: HTMLTableElement): string | null {
    const head = table.tHead
    if (!head) return null
    const computedBackground = getComputedStyle(head).backgroundColor
    if (!isTransparentColor(computedBackground)) return computedBackground

    let element: Element | null = head
    while (element) {
        const value = getComputedStyle(element).getPropertyValue('--app-md-table-head-bg').trim()
        if (value) return value
        element = element.parentElement
    }
    return getComputedStyle(document.documentElement).getPropertyValue('--app-md-table-head-bg').trim() || null
}

function applyTableImageHeaderBackground(table: HTMLTableElement, clone: HTMLTableElement): void {
    const background = getTableHeaderBackground(table)
    const cloneHead = clone.tHead
    if (!background || !cloneHead) return

    cloneHead.style.setProperty('background-color', background, 'important')
    cloneHead.querySelectorAll(':is(th, td)').forEach((cell) => {
        if (!(cell instanceof HTMLElement)) return
        if (!isTransparentColor(cell.style.getPropertyValue('background-color'))) return
        cell.style.setProperty('background-color', background, 'important')
    })
}

function createStaticTableImageClone(
    table: HTMLTableElement,
    tableWidth: number,
    tableHeight: number,
    tileTop = 0,
    tileHeight?: number,
): {
    table: HTMLTableElement
    capture: HTMLElement
    cleanup: () => void
} {
    const wrapper = document.createElement('div')
    wrapper.dataset.hapiTableImageRender = 'true'
    Object.assign(wrapper.style, {
        position: 'fixed',
        left: '-100000px',
        top: '0',
        width: `${tableWidth}px`,
        maxWidth: 'none',
        height: tileHeight == null ? 'auto' : `${tileHeight}px`,
        overflow: tileHeight == null ? 'visible' : 'hidden',
        pointerEvents: 'none',
    })

    const clone = table.cloneNode(true) as HTMLTableElement
    clone.style.setProperty('width', `${tableWidth}px`, 'important')
    clone.style.setProperty('min-width', `${tableWidth}px`, 'important')
    clone.style.setProperty('height', `${tableHeight}px`, 'important')
    copyTableImageStyles(table, clone)
    applyTableImageColumnWidths(table, clone, tableWidth)
    applyTableImageHeaderBackground(table, clone)
    if (tileHeight != null && tileTop > 0) {
        clone.style.setProperty('transform', `translateY(-${tileTop}px)`, 'important')
    }
    clone.querySelectorAll('thead, thead *').forEach((element) => {
        if (!(element instanceof HTMLElement)) return
        element.style.setProperty('position', 'static', 'important')
        element.style.removeProperty('top')
        element.style.removeProperty('z-index')
    })

    wrapper.appendChild(clone)
    document.body.appendChild(wrapper)
    return {
        table: clone,
        capture: tileHeight == null ? clone : wrapper,
        cleanup: () => wrapper.remove(),
    }
}

export const MAX_TABLE_EXPORT_PIXELS = 36_000_000
export const MAX_TABLE_EXPORT_TILE_PIXELS = 12_000_000
export const MAX_TABLE_EXPORT_DIMENSION = 16_384

export function getTableExportScale(
    tableWidth: number,
    tableHeight: number,
    devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio,
): number {
    const area = Math.max(1, tableWidth) * Math.max(1, tableHeight)
    const dimensionScale = MAX_TABLE_EXPORT_DIMENSION / Math.max(tableWidth, tableHeight)
    return Math.min(
        devicePixelRatio || 1,
        2,
        Math.sqrt(MAX_TABLE_EXPORT_PIXELS / area),
        dimensionScale,
    )
}

export function getTableExportTileHeight(tableWidth: number, scale: number): number {
    return Math.max(1, Math.floor(
        MAX_TABLE_EXPORT_TILE_PIXELS / Math.max(1, tableWidth * scale * scale),
    ))
}

export function getTableExportHeight(table: HTMLTableElement): number {
    const tableRect = table.getBoundingClientRect()
    const fallbackHeight = Math.max(table.scrollHeight, Math.ceil(tableRect.height), 1)
    const rowBottoms = Array.from(table.rows)
        .map((row) => row.getBoundingClientRect())
        .filter((rowRect) => rowRect.height > 0 && Number.isFinite(rowRect.bottom))
        .map((rowRect) => rowRect.bottom - tableRect.top)
    if (rowBottoms.length === 0) return fallbackHeight

    const contentHeight = Math.ceil(Math.max(...rowBottoms))
    return contentHeight > 0 ? Math.min(fallbackHeight, contentHeight) : fallbackHeight
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png')).then((blob) => {
        if (!blob) throw new Error('Failed to encode table image')
        return blob
    })
}

export async function renderTableAsImage(table: HTMLTableElement): Promise<Blob> {
    if (typeof document === 'undefined') throw new Error('Cannot render a table outside the browser')

    const { default: html2canvas } = await import('html2canvas-pro')
    const tableRect = table.getBoundingClientRect()
    const tableWidth = Math.max(table.scrollWidth, Math.ceil(tableRect.width), 1)
    const tableHeight = getTableExportHeight(table)
    const tableBackground = getComputedStyle(table).backgroundColor
    const backgroundColor = tableBackground === 'rgba(0, 0, 0, 0)'
        ? getComputedStyle(document.body).backgroundColor
        : tableBackground
    const scale = getTableExportScale(tableWidth, tableHeight)
    const rasterPixels = tableWidth * tableHeight * scale * scale
    const renderOptions = {
        backgroundColor: backgroundColor || null,
        foreignObjectRendering: false,
        logging: false,
        scale,
        useCORS: true,
        windowWidth: Math.max(document.documentElement.clientWidth, tableWidth),
        windowHeight: Math.max(document.documentElement.clientHeight, tableHeight),
    }

    if (rasterPixels <= MAX_TABLE_EXPORT_TILE_PIXELS) {
        const imageTable = createStaticTableImageClone(table, tableWidth, tableHeight)
        try {
            const canvas = await html2canvas(imageTable.capture, {
                ...renderOptions,
                width: tableWidth,
                height: tableHeight,
            })
            return canvasToPngBlob(canvas)
        } finally {
            imageTable.cleanup()
        }
    }

    const outputCanvas = document.createElement('canvas')
    outputCanvas.width = Math.max(1, Math.ceil(tableWidth * scale))
    outputCanvas.height = Math.max(1, Math.ceil(tableHeight * scale))
    const outputContext = outputCanvas.getContext('2d')
    if (!outputContext) throw new Error('Failed to create table image canvas')

    const tileHeight = getTableExportTileHeight(tableWidth, scale)
    for (let tileTop = 0; tileTop < tableHeight; tileTop += tileHeight) {
        const currentTileHeight = Math.min(tileHeight, tableHeight - tileTop)
        const imageTable = createStaticTableImageClone(table, tableWidth, tableHeight, tileTop, currentTileHeight)
        try {
            const tileCanvas = await html2canvas(imageTable.capture, {
                ...renderOptions,
                width: tableWidth,
                height: currentTileHeight,
                windowHeight: Math.max(document.documentElement.clientHeight, currentTileHeight),
            })
            const destinationTop = Math.round(tileTop * scale)
            const destinationBottom = tileTop + currentTileHeight >= tableHeight
                ? outputCanvas.height
                : Math.round((tileTop + currentTileHeight) * scale)
            outputContext.drawImage(
                tileCanvas,
                0,
                0,
                tileCanvas.width,
                tileCanvas.height,
                0,
                destinationTop,
                outputCanvas.width,
                Math.max(1, destinationBottom - destinationTop),
            )
        } finally {
            imageTable.cleanup()
        }
    }

    return canvasToPngBlob(outputCanvas)
}

export async function saveTableAsImage(table: HTMLTableElement, filename = getShareImageFileName('Table', 'table')): Promise<void> {
    const blob = await renderTableAsImage(table)
    await downloadBlob(blob, filename)
}

function writeTableImageToClipboard(
    mimeType: string,
    image: Blob | PromiseLike<Blob>,
): Promise<void> {
    try {
        const ClipboardItemCtor = window.ClipboardItem
        if (!navigator.clipboard?.write || !ClipboardItemCtor) {
            throw new Error('Image clipboard is not supported in this browser')
        }
        return Promise.resolve(navigator.clipboard.write([
            new ClipboardItemCtor({ [mimeType]: image }),
        ]))
    } catch (error) {
        if (!(image instanceof Blob)) {
            void Promise.resolve(image).catch(() => undefined)
        }
        return Promise.reject(error)
    }
}

export function copyTableImageToClipboard(blob: Blob): Promise<void> {
    return writeTableImageToClipboard(blob.type, blob)
}

export function copyTableImagePromiseToClipboard(imagePromise: Promise<Blob>): Promise<void> {
    return writeTableImageToClipboard('image/png', imagePromise)
}

/**
 * Mobile browsers generally only honor orientation locks from fullscreen.
 * Keep this best-effort so unsupported browsers still get the full table view.
 */
export async function enterMobileTableViewer(isViewerOpen?: () => boolean): Promise<boolean> {
    if (typeof document === 'undefined') return false

    let enteredFullscreen = false
    const root = document.documentElement
    if (!document.fullscreenElement && typeof root.requestFullscreen === 'function') {
        try {
            await root.requestFullscreen()
            enteredFullscreen = true
        } catch {
            // Fullscreen can be denied by browser policy; keep the viewer usable.
        }
    }

    const orientation = typeof window !== 'undefined'
        ? window.screen.orientation as unknown as TableOrientationApi | undefined
        : undefined
    if (orientation && typeof orientation.lock === 'function') {
        try {
            void orientation.lock('landscape').then(() => {
                const viewerStillOpen = isViewerOpen?.() ?? false
                if (enteredFullscreen && !document.fullscreenElement && !viewerStillOpen) {
                    try {
                        orientation.unlock?.()
                    } catch {
                        // Ignore browsers that reject unlock after an interrupted rotation.
                    }
                }
            }).catch(() => undefined)
        } catch {
            // Orientation lock is unavailable on some browsers and iOS versions.
        }
    }

    return enteredFullscreen
}

export function leaveMobileTableViewer(enteredFullscreen: boolean): void {
    if (typeof window !== 'undefined') {
        const orientation = window.screen.orientation as unknown as TableOrientationApi | undefined
        if (orientation && typeof orientation.unlock === 'function') {
            try {
                orientation.unlock()
            } catch {
                // Ignore browsers that reject unlock after an interrupted rotation.
            }
        }
    }

    if (enteredFullscreen && typeof document !== 'undefined' && typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => {
            // The user may already have exited browser fullscreen manually.
        })
    }
}

function TableViewer(props: {
    open: boolean
    onClose: () => void
    tableProps: TableProps
    tableRef: RefObject<HTMLTableElement | null>
    imageTitle: string
    tableWrapPreferenceKey?: string
}) {
    const { t } = useTranslation()
    const { className, children, ...rest } = props.tableProps
    const { copied, copy, markCopied } = useCopyToClipboard()
    const [imageAction, setImageAction] = useState<'copy' | 'download' | null>(null)
    const [imageError, setImageError] = useState(false)
    const [wrapEnabled, setWrapEnabled] = useState(false)
    const [toolbarVisible, setToolbarVisible] = useState(true)
    const viewerRef = useRef<HTMLDivElement>(null)
    const toolbarRef = useRef<HTMLDivElement>(null)
    const lastScrollTopRef = useRef(0)
    const reverseScrollDistanceRef = useRef(0)
    const toolbarVisibleRef = useRef(true)
    const explicitWrapRef = useRef(false)
    const isMobileViewer = isMobileTableViewerViewport()

    const setToolbarState = useCallback((visible: boolean) => {
        if (toolbarVisibleRef.current === visible) return
        toolbarVisibleRef.current = visible
        setToolbarVisible(visible)
    }, [])

    const handleViewerScroll = useCallback(() => {
        const viewer = viewerRef.current
        if (!viewer) return

        const scrollTop = viewer.scrollTop
        const previousScrollTop = lastScrollTopRef.current
        lastScrollTopRef.current = scrollTop
        const delta = scrollTop - previousScrollTop

        if (scrollTop <= 0) {
            reverseScrollDistanceRef.current = 0
            setToolbarState(true)
        } else if (delta > 0) {
            reverseScrollDistanceRef.current = 0
            const toolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0
            const distanceToBottom = Math.max(0, viewer.scrollHeight - viewer.clientHeight - scrollTop)
            setToolbarState(toolbarHeight > 0 && distanceToBottom < toolbarHeight)
        } else if (delta < 0 && !toolbarVisibleRef.current) {
            reverseScrollDistanceRef.current += -delta
            const distanceToBottom = Math.max(0, viewer.scrollHeight - viewer.clientHeight - scrollTop)
            if (reverseScrollDistanceRef.current >= 12 && distanceToBottom > 8) {
                reverseScrollDistanceRef.current = 0
                setToolbarState(true)
            }
        } else if (delta >= 0) {
            reverseScrollDistanceRef.current = 0
        }
    }, [setToolbarState])

    const setViewerElement = useCallback((viewer: HTMLDivElement | null) => {
        const previousViewer = viewerRef.current
        if (previousViewer) previousViewer.removeEventListener('scroll', handleViewerScroll)

        viewerRef.current = viewer
        if (!viewer) return

        reverseScrollDistanceRef.current = 0
        lastScrollTopRef.current = viewer.scrollTop
        setToolbarState(viewer.scrollTop <= 0)
        viewer.addEventListener('scroll', handleViewerScroll, { passive: true })
    }, [handleViewerScroll, setToolbarState])

    useEffect(() => {
        if (!props.open) {
            lastScrollTopRef.current = 0
            reverseScrollDistanceRef.current = 0
            setToolbarState(true)
        }
    }, [props.open, setToolbarState])

    useEffect(() => () => {
        viewerRef.current?.removeEventListener('scroll', handleViewerScroll)
    }, [handleViewerScroll])

    useEffect(() => {
        if (!props.open) {
            setWrapEnabled(false)
            setImageError(false)
        }
    }, [props.open])

    useLayoutEffect(() => {
        if (!props.open) {
            explicitWrapRef.current = false
            return undefined
        }

        const storedPreference = readTableWrapPreference(props.tableWrapPreferenceKey)
        explicitWrapRef.current = storedPreference !== null
        if (storedPreference !== null) {
            setWrapEnabled(storedPreference)
            return undefined
        }

        const measureOverflow = () => {
            if (explicitWrapRef.current) return
            const viewer = viewerRef.current
            const table = props.tableRef.current
            if (!viewer || !table) return
            const shouldWrap = shouldWrapTableByDefault(table, viewer)
            setWrapEnabled(shouldWrap)
        }

        let observer: ResizeObserver | undefined
        const frame = window.requestAnimationFrame(() => {
            measureOverflow()
            const viewer = viewerRef.current
            if (viewer && typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(measureOverflow)
                observer.observe(viewer)
            }
        })
        window.addEventListener('resize', measureOverflow)
        return () => {
            window.cancelAnimationFrame(frame)
            observer?.disconnect()
            window.removeEventListener('resize', measureOverflow)
        }
    }, [props.open, props.tableRef, props.tableWrapPreferenceKey])

    const handleWrapToggle = useCallback(() => {
        const nextValue = !wrapEnabled
        explicitWrapRef.current = true
        setWrapEnabled(nextValue)
        writeTableWrapPreference(props.tableWrapPreferenceKey, nextValue)
    }, [props.tableWrapPreferenceKey, wrapEnabled])

    const handleDownload = useCallback(() => {
        if (props.tableRef.current) {
            downloadTableAsCsv(props.tableRef.current, getShareTableFileName(props.imageTitle, 'csv'))
        }
    }, [props.imageTitle, props.tableRef])

    const handleCopyMarkdown = useCallback(() => {
        if (props.tableRef.current) {
            void copy(serializeTableToMarkdown(props.tableRef.current))
        }
    }, [copy, props.tableRef])

    const getPreparedImage = useCallback((table: HTMLTableElement): Promise<Blob> => {
        return renderTableAsImage(table)
    }, [])

    const handleSaveImage = useCallback(() => {
        const table = props.tableRef.current
        if (!table || imageAction) return

        setImageError(false)
        setImageAction('download')
        const filename = getShareImageFileName(props.imageTitle, 'table')
        void getPreparedImage(table)
            .then((blob) => downloadBlob(blob, filename))
            .catch(() => setImageError(true))
            .finally(() => setImageAction(null))
    }, [getPreparedImage, imageAction, props.imageTitle, props.tableRef])

    const handleCopyImage = useCallback(() => {
        const table = props.tableRef.current
        if (!table || imageAction) return

        setImageError(false)
        setImageAction('copy')
        const imagePromise = getPreparedImage(table)
        void copyTableImagePromiseToClipboard(imagePromise)
            .then(() => markCopied())
            .catch(() => setImageError(true))
            .finally(() => setImageAction(null))
    }, [getPreparedImage, imageAction, markCopied, props.tableRef])

    const viewerTitle = props.imageTitle.trim() || t('table.viewerTitle')

    return (
        <DialogPrimitive.Root
            open={props.open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) props.onClose()
            }}
        >
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--app-bg)]" />
                <DialogPrimitive.Content
                    aria-label={viewerTitle}
                    className="fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col bg-[var(--app-bg)] p-0 outline-none"
                >
                    {imageAction ? (
                        <div
                            data-hapi-table-save-status="true"
                            data-hapi-table-save-status-action={imageAction}
                            role="status"
                            aria-live="polite"
                            className={cn(
                                'pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs',
                                imageAction === 'copy'
                                    ? 'border border-[var(--app-fg)] bg-[var(--app-fg)] text-[var(--app-bg)] shadow-md'
                                    : 'border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[var(--app-hint)] shadow-sm backdrop-blur',
                            )}
                        >
                            <Spinner size="sm" label={null} className="text-current" />
                            <span>{t(imageAction === 'copy' ? 'table.copyingImage' : 'table.savingImage')}</span>
                        </div>
                    ) : null}
                    {imageError ? (
                        <div
                            role="alert"
                            aria-live="assertive"
                            className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-1 text-xs text-[var(--app-fg)] shadow-md"
                        >
                            {t('table.imageActionFailed')}
                        </div>
                    ) : null}
                    <DialogPrimitive.Title className="sr-only">
                        {viewerTitle}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="sr-only">
                        {viewerTitle}
                    </DialogPrimitive.Description>

                    <div
                        ref={toolbarRef}
                        data-hapi-table-viewer-toolbar="true"
                        aria-hidden={!toolbarVisible}
                        className={cn(
                            'flex shrink-0 items-center gap-1 overflow-hidden bg-[var(--app-bg)]/95 backdrop-blur-sm transition-[max-height,opacity,padding,border-color] duration-200',
                            toolbarVisible
                                ? 'max-h-24 px-1.5 py-0 opacity-100'
                                : 'pointer-events-none max-h-0 border-transparent p-0 opacity-0',
                        )}
                    >
                        <button
                            type="button"
                            data-hapi-table-viewer-control="true"
                            tabIndex={toolbarVisible ? 0 : -1}
                            aria-label={t('table.closeFullscreen')}
                            title={t('table.closeFullscreen')}
                            onClick={props.onClose}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <CloseIcon className="h-5 w-5" />
                        </button>
                        <div
                            data-hapi-table-viewer-heading="true"
                            className="min-w-0 flex-1 truncate text-lg font-semibold text-[var(--app-fg)]"
                        >
                            {viewerTitle}
                        </div>
                        <div className="ml-auto flex items-center gap-1">
                            <button
                                type="button"
                                data-hapi-table-viewer-control="true"
                                data-hapi-table-wrap-toggle="true"
                                tabIndex={toolbarVisible ? 0 : -1}
                                aria-label={t(wrapEnabled ? 'table.wrap.disable' : 'table.wrap.enable')}
                                title={t(wrapEnabled ? 'table.wrap.disable' : 'table.wrap.enable')}
                                aria-pressed={wrapEnabled}
                                onClick={handleWrapToggle}
                                className={cn(
                                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                    wrapEnabled ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]',
                                )}
                            >
                                <WrapIcon className="h-5 w-5" />
                            </button>
                            {isMobileViewer ? (
                                <button
                                    type="button"
                                    data-hapi-table-viewer-control="true"
                                    tabIndex={toolbarVisible ? 0 : -1}
                                    aria-label={copied ? t('table.copiedMarkdown') : t('table.copyMarkdownButton')}
                                    title={copied ? t('table.copiedMarkdown') : t('table.copyMarkdownButton')}
                                    onClick={handleCopyMarkdown}
                                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    {copied ? <CheckIcon className="h-5 w-5" /> : <CopyIcon className="h-5 w-5" />}
                                </button>
                            ) : (
                                <TableActionMenu
                                    label={t('table.copy')}
                                    tabIndex={toolbarVisible ? 0 : -1}
                                    items={[
                                        { label: t('table.copyImage'), onSelect: handleCopyImage, disabled: imageAction !== null },
                                        { label: t('table.copyMarkdown'), onSelect: handleCopyMarkdown },
                                    ]}
                                >
                                    {copied ? <CheckIcon className="h-5 w-5" /> : <CopyIcon className="h-5 w-5" />}
                                </TableActionMenu>
                            )}
                            <TableActionMenu
                                label={t('table.download')}
                                tabIndex={toolbarVisible ? 0 : -1}
                                items={[
                                    { label: t('table.downloadPng'), onSelect: handleSaveImage, disabled: imageAction !== null },
                                    { label: t('table.downloadCsv'), onSelect: handleDownload },
                                ]}
                            >
                                <DownloadIcon className="h-5 w-5" />
                            </TableActionMenu>
                        </div>
                    </div>

                    <div
                        ref={setViewerElement}
                        data-hapi-table-viewer="true"
                        className={cn(
                            'min-h-0 flex-1 overscroll-contain pb-0 pl-0 pr-0 pt-0',
                            wrapEnabled ? 'overflow-x-hidden overflow-y-auto' : 'overflow-auto',
                        )}
                    >
                        <table
                            {...rest}
                            ref={props.tableRef}
                            data-hapi-table-wrap={wrapEnabled ? 'true' : undefined}
                            className={cn('aui-md-table w-max min-w-full border-collapse text-sm', className)}
                        >
                            {children}
                        </table>
                    </div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    )
}

/** Reuse the same table viewer for tables rendered inside a share preview. */
export function TableViewerFromElement(props: {
    open: boolean
    onClose: () => void
    table: HTMLTableElement
    imageTitle: string
}) {
    const tableRef = useRef<HTMLTableElement | null>(null)
    const tableProps: TableProps = {
        className: cn(props.table.getAttribute('class'), 'w-max min-w-full'),
        dangerouslySetInnerHTML: { __html: props.table.innerHTML },
    }

    return (
        <TableViewer
            open={props.open}
            onClose={props.onClose}
            tableProps={tableProps}
            tableRef={tableRef}
            imageTitle={props.imageTitle}
            tableWrapPreferenceKey={getTableWrapPreferenceKey(props.table, props.imageTitle)}
        />
    )
}

export function MarkdownTable(props: TableProps) {
    const { t } = useTranslation()
    const chatContext = useOptionalHappyChatContext()
    const { className, children, ...rest } = props
    const inlineTableRef = useRef<HTMLTableElement>(null)
    const viewerTableRef = useRef<HTMLTableElement>(null)
    const tableWrapPreferenceKeyRef = useRef<string | undefined>(undefined)
    const [viewerOpen, setViewerOpen] = useState(false)
    const openRef = useRef(false)
    const mobileViewerRef = useRef(false)
    const enteredFullscreenRef = useRef(false)
    const imageTitle = chatContext?.sessionTitle?.trim() || t('table.viewerTitle')
    const tableWrapScope = chatContext?.sessionId ?? imageTitle

    const closeViewer = useCallback(() => {
        openRef.current = false
        setViewerOpen(false)

        if (mobileViewerRef.current) {
            mobileViewerRef.current = false
            const enteredFullscreen = enteredFullscreenRef.current
            enteredFullscreenRef.current = false
            leaveMobileTableViewer(enteredFullscreen)
        }
    }, [])

    const openViewer = useCallback(() => {
        openRef.current = true
        const table = inlineTableRef.current
        tableWrapPreferenceKeyRef.current = table
            ? getTableWrapPreferenceKey(table, tableWrapScope)
            : undefined
        setViewerOpen(true)

        const isMobile = isMobileTableViewerViewport()
        mobileViewerRef.current = isMobile
        if (!isMobile) return

        void enterMobileTableViewer(() => openRef.current).then((enteredFullscreen) => {
            if (!openRef.current) {
                leaveMobileTableViewer(enteredFullscreen)
                return
            }
            enteredFullscreenRef.current = enteredFullscreen
        })
    }, [tableWrapScope])

    useEffect(() => {
        if (typeof document === 'undefined') return undefined

        const handleFullscreenChange = () => {
            if (!openRef.current || !mobileViewerRef.current || !enteredFullscreenRef.current) return
            if (document.fullscreenElement) return

            leaveMobileTableViewer(false)
            enteredFullscreenRef.current = false
            mobileViewerRef.current = false
            openRef.current = false
            setViewerOpen(false)
        }

        document.addEventListener('fullscreenchange', handleFullscreenChange)
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }, [])

    useEffect(() => () => {
        const wasMobile = mobileViewerRef.current
        const enteredFullscreen = enteredFullscreenRef.current
        openRef.current = false
        mobileViewerRef.current = false
        enteredFullscreenRef.current = false
        if (wasMobile) leaveMobileTableViewer(enteredFullscreen)
    }, [])

    const tableProps = { ...rest, className, children }

    return (
        <>
            <div
                className="aui-md-table-shell aui-md-table-wrapper aui-md-table-frame relative my-3 max-w-full"
                aria-hidden={viewerOpen || undefined}
            >
                <div className="max-w-full overflow-x-auto rounded-xl bg-[var(--app-md-table-bg)]">
                    <table
                        {...rest}
                        ref={inlineTableRef}
                        className={cn('aui-md-table w-full border-collapse text-sm', className)}
                    >
                        {children}
                    </table>
                </div>
                <div data-hapi-share-export-exclude="true" className="aui-md-table-actions flex items-center">
                    <TableActionButton label={t('table.openFullscreen')} onClick={openViewer} variant="ghost">
                        <ExpandIcon className="h-4 w-4" />
                    </TableActionButton>
                </div>
            </div>

            <TableViewer
                open={viewerOpen}
                onClose={closeViewer}
                tableProps={tableProps}
                tableRef={viewerTableRef}
                imageTitle={imageTitle}
                tableWrapPreferenceKey={tableWrapPreferenceKeyRef.current}
            />
        </>
    )
}
