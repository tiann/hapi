import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

const html2canvas = vi.hoisted(() => vi.fn())
vi.mock('html2canvas-pro', () => ({ default: html2canvas }))

import {
    copyTableImagePromiseToClipboard,
    downloadTableAsCsv,
    getTableExportScale,
    getTableExportHeight,
    getTableExportTileHeight,
    isMobileTableViewerViewport,
    MAX_TABLE_EXPORT_DIMENSION,
    MAX_TABLE_EXPORT_PIXELS,
    MAX_TABLE_EXPORT_TILE_PIXELS,
    renderTableAsImage,
    saveTableAsImage,
    shouldWrapTableByDefault,
    serializeTableToMarkdown,
    serializeTableToCsv,
    TableViewerFromElement,
} from './MarkdownTable'

const TABLE_MARKDOWN = `| Project | Stars |
| --- | ---: |
| HAPI | 128 |
| HAPI, local-first | 42 |`

function renderTable(locale: 'en' | 'zh-CN' = 'en') {
    localStorage.setItem('hapi-lang', locale)
    return render(
        <I18nProvider>
            <MarkdownRenderer standalone content={TABLE_MARKDOWN} />
        </I18nProvider>,
    )
}

describe('MarkdownTable', () => {
    const originalMatchMedia = window.matchMedia
    const originalOrientation = window.screen.orientation
    const originalNavigatorShare = navigator.share
    const originalNavigatorCanShare = navigator.canShare
    const originalNavigatorClipboard = navigator.clipboard
    const originalClipboardItem = window.ClipboardItem
    const originalMaxTouchPoints = navigator.maxTouchPoints
    const originalUserAgent = navigator.userAgent
    const originalInnerWidth = window.innerWidth
    const originalInnerHeight = window.innerHeight

    beforeEach(() => {
        localStorage.clear()
        vi.restoreAllMocks()
        html2canvas.mockReset()
        window.matchMedia = originalMatchMedia
        Object.defineProperty(navigator, 'share', {
            configurable: true,
            value: originalNavigatorShare,
        })
        Object.defineProperty(navigator, 'canShare', {
            configurable: true,
            value: originalNavigatorCanShare,
        })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalNavigatorClipboard })
        Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: originalClipboardItem })
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: originalMaxTouchPoints })
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent })
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: originalOrientation,
        })
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
    })

    afterEach(() => {
        window.matchMedia = originalMatchMedia
        Object.defineProperty(navigator, 'share', {
            configurable: true,
            value: originalNavigatorShare,
        })
        Object.defineProperty(navigator, 'canShare', {
            configurable: true,
            value: originalNavigatorCanShare,
        })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalNavigatorClipboard })
        Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: originalClipboardItem })
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: originalMaxTouchPoints })
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent })
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: originalOrientation,
        })
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
    })

    it('keeps the table header as the first row while exposing only a plain fullscreen action', () => {
        renderTable()

        const table = screen.getByRole('table')
        expect(table.firstElementChild?.tagName).toBe('THEAD')
        expect(table.parentElement?.parentElement).toHaveClass('aui-md-table-shell')
        const actions = table.parentElement?.parentElement?.querySelector('.aui-md-table-actions')
        expect(actions?.querySelectorAll('button')).toHaveLength(1)
        expect(actions).toHaveAttribute('data-hapi-share-export-exclude', 'true')
        expect(screen.getByRole('button', { name: 'Open table full screen' })).toBeInTheDocument()
    })

    it('does not size inline table actions to the wrapped header row', () => {
        renderTable()

        const actions = screen.getByRole('button', { name: 'Open table full screen' }).parentElement
        if (!actions) throw new Error('Inline table action geometry is incomplete')
        expect(actions).not.toHaveStyle({ height: '56px' })
    })

    it('opens an enlarged PC viewer without requesting browser fullscreen or orientation lock', async () => {
        const requestFullscreen = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: requestFullscreen,
        })
        const lock = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: { lock, unlock: vi.fn() },
        })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))

        expect(await screen.findByRole('dialog', { name: 'Table' })).toBeInTheDocument()
        const dialog = screen.getByRole('dialog', { name: 'Table' })
        expect(dialog).toContainElement(screen.getByRole('table'))
        const wrapButton = screen.getByRole('button', { name: 'Enable table wrapping' })
        expect(wrapButton).toHaveAttribute('aria-pressed', 'false')
        const copyMenuTrigger = screen.getByRole('button', { name: 'Copy table' })
        expect(copyMenuTrigger).toHaveAttribute('aria-haspopup', 'menu')
        fireEvent.click(copyMenuTrigger)
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy image', 'Copy Markdown'])
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Markdown' }))
        const downloadMenuTrigger = screen.getByRole('button', { name: 'Download table' })
        expect(downloadMenuTrigger).toHaveAttribute('aria-haspopup', 'menu')
        fireEvent.click(downloadMenuTrigger)
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Download PNG', 'Download CSV'])
        expect(requestFullscreen).not.toHaveBeenCalled()
        expect(lock).not.toHaveBeenCalled()

        fireEvent.click(wrapButton)
        expect(screen.getByRole('button', { name: 'Disable table wrapping' })).toHaveAttribute('aria-pressed', 'true')
        expect(dialog.querySelector('[data-hapi-table-viewer="true"]')).toHaveClass('overflow-x-hidden', 'overflow-y-auto')
        expect(dialog.querySelector('[data-hapi-table-wrap="true"]')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Close table full screen' }))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Table' })).not.toBeInTheDocument())
    })

    it('uses concise Chinese labels for the copy and download menus', async () => {
        renderTable('zh-CN')
        fireEvent.click(screen.getByRole('button', { name: '横向全屏查看表格' }))

        await screen.findByRole('dialog', { name: '表格' })
        fireEvent.click(screen.getByRole('button', { name: '复制表格' }))
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['复制图片', '复制 Markdown'])
        fireEvent.click(screen.getByRole('menuitem', { name: '复制 Markdown' }))

        fireEvent.click(screen.getByRole('button', { name: '下载表格' }))
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['下载 PNG', '下载 CSV'])
    })

    it('keeps shared-preview tables at max-content width when the source uses w-full', async () => {
        const sourceTable = document.createElement('table')
        sourceTable.className = 'aui-md-table w-full border-collapse text-sm'
        sourceTable.innerHTML = '<thead><tr><th>Project</th></tr></thead><tbody><tr><td>HAPI</td></tr></tbody>'

        render(
            <I18nProvider>
                <TableViewerFromElement
                    open
                    onClose={() => {}}
                    table={sourceTable}
                    imageTitle="Shared table"
                />
            </I18nProvider>,
        )

        const dialog = await screen.findByRole('dialog', { name: 'Shared table' })
        const viewerTable = dialog.querySelector('table')
        expect(viewerTable).toHaveClass('w-max', 'min-w-full')
        expect(viewerTable).not.toHaveClass('w-full')
    })

    it('remembers an explicit wrapping choice when the same table is reopened', async () => {
        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await screen.findByRole('dialog', { name: 'Table' })
        fireEvent.click(screen.getByRole('button', { name: 'Enable table wrapping' }))
        expect(screen.getByRole('button', { name: 'Disable table wrapping' })).toHaveAttribute('aria-pressed', 'true')

        fireEvent.click(screen.getByRole('button', { name: 'Close table full screen' }))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Table' })).not.toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))

        const reopenedDialog = await screen.findByRole('dialog', { name: 'Table' })
        expect(screen.getByRole('button', { name: 'Disable table wrapping' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Close table full screen' }))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Table' })).not.toBeInTheDocument())
        expect(reopenedDialog).toBeTruthy()
    })

    it('uses horizontal overflow to choose the first-open default', () => {
        const table = document.createElement('table')
        const viewer = document.createElement('div')
        Object.defineProperty(table, 'scrollWidth', { configurable: true, value: 901 })
        Object.defineProperty(viewer, 'clientWidth', { configurable: true, value: 900 })
        expect(shouldWrapTableByDefault(table, viewer)).toBe(false)

        Object.defineProperty(table, 'scrollWidth', { configurable: true, value: 902 })
        expect(shouldWrapTableByDefault(table, viewer)).toBe(true)
    })

    it('shows a saving status while the PNG is being generated', async () => {
        type CanvasStub = { toBlob: (callback: BlobCallback) => void }
        let resolveCanvas: ((value: CanvasStub | PromiseLike<CanvasStub>) => void) | undefined
        html2canvas.mockReturnValue(new Promise<CanvasStub>((resolve) => {
            resolveCanvas = resolve
        }))
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hapi-table-image')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Download table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Download PNG' }))

        const savingStatus = screen.getByRole('status')
        expect(savingStatus).toHaveTextContent('Saving image…')
        expect(savingStatus).toHaveAttribute('data-hapi-table-save-status', 'true')
        expect(savingStatus).toHaveClass('left-1/2', '-translate-x-1/2', 'rounded-full')
        expect(savingStatus.querySelector('svg')).toHaveClass('animate-spin')

        resolveCanvas?.({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })

    it('copies a generated table image from the PC copy menu', async () => {
        type CanvasStub = { toBlob: (callback: BlobCallback) => void }
        let resolveCanvas: ((value: CanvasStub | PromiseLike<CanvasStub>) => void) | undefined
        html2canvas.mockReturnValue(new Promise<CanvasStub>((resolve) => {
            resolveCanvas = resolve
        }))
        const write = vi.fn().mockResolvedValue(undefined)
        class ClipboardItemStub {
            constructor(public readonly data: Record<string, Blob | PromiseLike<Blob>>) {}
        }
        Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: ClipboardItemStub })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await screen.findByRole('dialog', { name: 'Table' })
        fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy image' }))

        expect(write).toHaveBeenCalledTimes(1)
        const clipboardItem = write.mock.calls[0]?.[0]?.[0] as ClipboardItemStub | undefined
        expect(clipboardItem?.data['image/png']).toBeInstanceOf(Promise)
        expect(screen.getByRole('status')).toHaveTextContent('Copying image…')
        expect(screen.getByRole('status')).toHaveAttribute('data-hapi-table-save-status-action', 'copy')
        expect(screen.getByRole('status')).toHaveClass(
            'border-[var(--app-fg)]',
            'bg-[var(--app-fg)]',
            'text-[var(--app-bg)]',
            'shadow-md',
        )
        resolveCanvas?.({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
        await waitFor(() => expect(write).toHaveBeenCalledWith([expect.any(ClipboardItemStub)]))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Copy table' }).querySelector('polyline')).toBeInTheDocument())
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })

    it('shows an error when PNG generation fails', async () => {
        html2canvas.mockRejectedValue(new Error('render failed'))

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await screen.findByRole('dialog', { name: 'Table' })
        fireEvent.click(screen.getByRole('button', { name: 'Download table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Download PNG' }))

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not process table image.'))
    })

    it('shows an error when copying the generated table image fails', async () => {
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
        const write = vi.fn().mockRejectedValue(new Error('clipboard denied'))
        class ClipboardItemStub {
            constructor(public readonly data: Record<string, Blob | PromiseLike<Blob>>) {}
        }
        Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: ClipboardItemStub })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await screen.findByRole('dialog', { name: 'Table' })
        fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy image' }))

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not process table image.'))
    })

    it('shows an error when creating the image clipboard item throws', async () => {
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
        class ClipboardItemStub {
            constructor() {
                throw new Error('clipboard item failed')
            }
        }
        Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: ClipboardItemStub })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: vi.fn() } })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await screen.findByRole('dialog', { name: 'Table' })
        fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy image' }))

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not process table image.'))
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('observes a pending raster rejection after clipboard setup throws synchronously', async () => {
        let rejectRaster: ((reason?: unknown) => void) | undefined
        const raster = new Promise<Blob>((_resolve, reject) => {
            rejectRaster = reject
        })
        class ClipboardItemStub {
            constructor() {
                throw new Error('clipboard item failed')
            }
        }
        Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: ClipboardItemStub })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: vi.fn() } })

        await expect(copyTableImagePromiseToClipboard(raster)).rejects.toThrow('clipboard item failed')
        rejectRaster?.(new Error('raster failed'))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    it('re-evaluates the automatic wrapping choice when the viewer width changes', async () => {
        let resizeCallback: ResizeObserverCallback | undefined
        class TestResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallback = callback
            }
            observe() {}
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', TestResizeObserver)

        try {
            renderTable()
            fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
            const dialog = await screen.findByRole('dialog', { name: 'Table' })
            const viewer = dialog.querySelector<HTMLElement>('[data-hapi-table-viewer="true"]')
            const table = viewer?.querySelector<HTMLTableElement>('table')
            if (!viewer || !table) throw new Error('Table viewer did not render')

            let viewerWidth = 100
            let tableWidth = 200
            Object.defineProperty(viewer, 'clientWidth', {
                configurable: true,
                get: () => viewerWidth,
            })
            Object.defineProperty(table, 'scrollWidth', {
                configurable: true,
                get: () => table.hasAttribute('data-hapi-table-wrap')
                    ? Math.min(tableWidth, viewerWidth)
                    : tableWidth,
            })

            await waitFor(() => expect(resizeCallback).toBeDefined())
            resizeCallback?.([], {} as ResizeObserver)
            await waitFor(() => expect(screen.getByRole('button', { name: 'Disable table wrapping' })).toHaveAttribute('aria-pressed', 'true'))

            viewerWidth = 150
            resizeCallback?.([], {} as ResizeObserver)
            await waitFor(() => expect(screen.getByRole('button', { name: 'Disable table wrapping' })).toHaveAttribute('aria-pressed', 'true'))

            viewerWidth = 300
            tableWidth = 200
            resizeCallback?.([], {} as ResizeObserver)
            await waitFor(() => expect(screen.getByRole('button', { name: 'Enable table wrapping' })).toHaveAttribute('aria-pressed', 'false'))
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('requests mobile browser fullscreen and landscape orientation, then releases both on close', async () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('max-width: 767px') || query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })

        const requestFullscreen = vi.fn().mockResolvedValue(undefined)
        const exitFullscreen = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: requestFullscreen,
        })
        Object.defineProperty(document, 'exitFullscreen', {
            configurable: true,
            value: exitFullscreen,
        })
        const lock = vi.fn().mockResolvedValue(undefined)
        const unlock = vi.fn()
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: { lock, unlock },
        })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))

        await waitFor(() => {
            expect(requestFullscreen).toHaveBeenCalledTimes(1)
            expect(lock).toHaveBeenCalledWith('landscape')
        })

        fireEvent.click(screen.getByRole('button', { name: 'Close table full screen' }))
        await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1))
        expect(unlock).toHaveBeenCalledTimes(1)
    })

    it('releases orientation when the browser exits fullscreen externally', async () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('max-width: 767px') || query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })

        const requestFullscreen = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: requestFullscreen,
        })
        const lock = vi.fn().mockResolvedValue(undefined)
        const unlock = vi.fn()
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: { lock, unlock },
        })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await waitFor(() => {
            expect(requestFullscreen).toHaveBeenCalledTimes(1)
            expect(lock).toHaveBeenCalledWith('landscape')
        })

        document.dispatchEvent(new Event('fullscreenchange'))
        await waitFor(() => expect(unlock).toHaveBeenCalledTimes(1))
        expect(screen.queryByRole('dialog', { name: 'Table' })).not.toBeInTheDocument()
    })

    it('does not miss external fullscreen exit while orientation lock is pending', async () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('max-width: 767px') || query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })

        const requestFullscreen = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: requestFullscreen,
        })
        let resolveLock: (() => void) | undefined
        const lock = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
            resolveLock = resolve
        }))
        const unlock = vi.fn()
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: { lock, unlock },
        })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await waitFor(() => {
            expect(requestFullscreen).toHaveBeenCalledTimes(1)
            expect(lock).toHaveBeenCalledWith('landscape')
        })

        document.dispatchEvent(new Event('fullscreenchange'))
        await waitFor(() => expect(unlock).toHaveBeenCalledTimes(1))
        expect(screen.queryByRole('dialog', { name: 'Table' })).not.toBeInTheDocument()
        resolveLock?.()
        await waitFor(() => expect(unlock).toHaveBeenCalledTimes(2))
    })

    it('cleans up a pending mobile fullscreen request when the table unmounts', async () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('max-width: 767px') || query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })

        let resolveFullscreen: (() => void) | undefined
        const requestFullscreen = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
            resolveFullscreen = resolve
        }))
        const exitFullscreen = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: requestFullscreen,
        })
        Object.defineProperty(document, 'exitFullscreen', {
            configurable: true,
            value: exitFullscreen,
        })
        const unlock = vi.fn()
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: { lock: vi.fn().mockResolvedValue(undefined), unlock },
        })

        const rendered = renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1))

        rendered.unmount()
        resolveFullscreen?.()
        await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1))
        expect(unlock).toHaveBeenCalled()
    })

    it('defers PNG rendering until the user requests an image save', async () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hapi-table-image')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        await screen.findByRole('dialog', { name: 'Table' })
        expect(html2canvas).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Download table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Download PNG' }))
        await waitFor(() => expect(html2canvas).toHaveBeenCalledTimes(1))
    })

    it('renders a fresh PNG after wrapping changes during an earlier render', async () => {
        type CanvasStub = { toBlob: (callback: BlobCallback) => void }
        const pending: Array<(value: CanvasStub | PromiseLike<CanvasStub>) => void> = []
        html2canvas.mockImplementation(() => new Promise<CanvasStub>((resolve) => pending.push(resolve)))
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hapi-table-image')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        const dialog = await screen.findByRole('dialog', { name: 'Table' })
        fireEvent.click(screen.getByRole('button', { name: 'Download table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Download PNG' }))
        await waitFor(() => expect(html2canvas).toHaveBeenCalledTimes(1))

        fireEvent.click(screen.getByRole('button', { name: 'Enable table wrapping' }))
        pending[0]?.({
            toBlob: (callback: BlobCallback) => callback(new Blob(['first'], { type: 'image/png' })),
        })
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: 'Download table' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Download PNG' }))
        await waitFor(() => expect(html2canvas).toHaveBeenCalledTimes(2))
        pending[1]?.({
            toBlob: (callback: BlobCallback) => callback(new Blob(['second'], { type: 'image/png' })),
        })
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })

    it('recognizes a coarse-pointer phone that starts in landscape', () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 915 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 412 })

        expect(isMobileTableViewerViewport()).toBe(true)
    })

    it('does not classify a touch-enabled Windows laptop as mobile', () => {
        window.matchMedia = vi.fn(() => ({
            matches: false,
            media: '',
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })

        expect(isMobileTableViewerViewport()).toBe(false)
    })

    it('hides the viewer toolbar while scrolling down and restores it while scrolling up', async () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('max-width: 767px') || query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })

        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: vi.fn().mockResolvedValue(undefined),
        })
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: { lock: vi.fn().mockResolvedValue(undefined), unlock: vi.fn() },
        })

        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        const dialog = await screen.findByRole('dialog', { name: 'Table' })
        const toolbar = dialog.querySelector('[data-hapi-table-viewer-toolbar="true"]')
        const viewer = dialog.querySelector('[data-hapi-table-viewer="true"]') as HTMLDivElement
        expect(toolbar).toHaveAttribute('aria-hidden', 'false')

        let scrollTop = 0
        Object.defineProperty(viewer, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
        })
        Object.defineProperty(viewer, 'scrollHeight', {
            configurable: true,
            get: () => 100,
        })
        Object.defineProperty(viewer, 'clientHeight', {
            configurable: true,
            get: () => 20,
        })

        scrollTop = 20
        fireEvent.scroll(viewer)
        await waitFor(() => expect(toolbar).toHaveAttribute('aria-hidden', 'true'))

        scrollTop = 15
        fireEvent.scroll(viewer)
        expect(toolbar).toHaveAttribute('aria-hidden', 'true')

        scrollTop = 80
        fireEvent.scroll(viewer)
        expect(toolbar).toHaveAttribute('aria-hidden', 'true')

        scrollTop = 79
        fireEvent.scroll(viewer)
        expect(toolbar).toHaveAttribute('aria-hidden', 'true')

        scrollTop = 80
        fireEvent.scroll(viewer)
        expect(toolbar).toHaveAttribute('aria-hidden', 'true')

        scrollTop = 79
        fireEvent.scroll(viewer)
        expect(toolbar).toHaveAttribute('aria-hidden', 'true')

        scrollTop = 65
        fireEvent.scroll(viewer)
        await waitFor(() => expect(toolbar).toHaveAttribute('aria-hidden', 'false'))

        scrollTop = 0
        fireEvent.scroll(viewer)
        await waitFor(() => expect(toolbar).toHaveAttribute('aria-hidden', 'false'))
    })

    it('keeps the toolbar visible when collapsing it would clamp the bottom scroll position', async () => {
        renderTable()
        fireEvent.click(screen.getByRole('button', { name: 'Open table full screen' }))
        const dialog = await screen.findByRole('dialog', { name: 'Table' })
        const toolbar = dialog.querySelector('[data-hapi-table-viewer-toolbar="true"]') as HTMLDivElement
        const viewer = dialog.querySelector('[data-hapi-table-viewer="true"]') as HTMLDivElement
        vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({ height: 36 } as DOMRect)

        let scrollTop = 0
        Object.defineProperty(viewer, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
        })
        Object.defineProperty(viewer, 'scrollHeight', {
            configurable: true,
            get: () => 100,
        })
        Object.defineProperty(viewer, 'clientHeight', {
            configurable: true,
            get: () => 64,
        })

        scrollTop = 36
        fireEvent.scroll(viewer)
        await waitFor(() => expect(toolbar).toHaveAttribute('aria-hidden', 'false'))
    })

    it('serializes table cells as an Excel-friendly CSV', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th><th>Stars</th></tr></thead><tbody><tr><td>HAPI</td><td>128</td></tr><tr><td>HAPI, local-first</td><td>42</td></tr></tbody>'

        expect(serializeTableToCsv(table)).toBe('\uFEFF"Project","Stars"\r\n"HAPI","128"\r\n"HAPI, local-first","42"\r\n')
    })

    it('neutralizes formula-leading CSV cells', () => {
        const table = document.createElement('table')
        table.innerHTML = '<tr><td>=SUM(A1:A2)</td><td>+10</td><td>-1</td><td>@command</td></tr>'

        expect(serializeTableToCsv(table)).toBe('\uFEFF"\'=SUM(A1:A2)","\'+10","\'-1","\'@command"\r\n')
    })

    it('serializes the rendered table as Markdown', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th><th>Notes</th></tr></thead><tbody><tr><td>HAPI</td><td>Supports | tables</td></tr></tbody>'

        expect(serializeTableToMarkdown(table)).toBe('| Project | Notes |\n| --- | --- |\n| HAPI | Supports \\| tables |\n')
    })

    it('preserves inline Markdown formatting when copying a table', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th><th>Notes</th></tr></thead><tbody><tr><td><a href="https://example.com">Docs</a></td><td><code>hapi</code> and <strong>fast</strong> <em>local</em></td></tr></tbody>'

        expect(serializeTableToMarkdown(table)).toBe('| Project | Notes |\n| --- | --- |\n| [Docs](https://example.com) | `hapi` and **fast** *local* |\n')
    })

    it('preserves original link targets and safe code fences when copying Markdown', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th><th>Notes</th></tr></thead><tbody><tr><td><a href="#" data-hapi-markdown-href="custom://target">Open</a></td><td><code>a`b</code> <code> a  b </code></td></tr></tbody>'

        expect(serializeTableToMarkdown(table)).toBe('| Project | Notes |\n| --- | --- |\n| [Open](custom://target) | ``a`b`` `  a  b  ` |\n')
    })

    it('preserves backslashes inside inline code when copying Markdown', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Path</th></tr></thead><tbody><tr><td></td></tr></tbody>'
        const code = document.createElement('code')
        code.textContent = 'C:\\tmp'
        table.tBodies[0]!.rows[0]!.cells[0]!.append(code)

        expect(serializeTableToMarkdown(table)).toBe('| Path |\n| --- |\n| `C:\\tmp` |\n')
    })

    it('omits internal HAPI file-link schemes when copying Markdown', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Files</th></tr></thead><tbody><tr><td></td></tr></tbody>'
        const cell = table.tBodies[0]!.rows[0]!.cells[0]!
        const plainLink = document.createElement('a')
        plainLink.setAttribute('href', 'hapi-file:docs%2Frouter.tsx')
        plainLink.textContent = 'docs/router.tsx'
        const codeLink = document.createElement('a')
        codeLink.setAttribute('href', 'hapi-file-candidate:docs%2Fmain.ts')
        const code = document.createElement('code')
        code.textContent = 'docs/main.ts'
        codeLink.append(code)
        cell.append(plainLink, ' ', codeLink)

        expect(serializeTableToMarkdown(table)).toBe('| Files |\n| --- |\n| docs/router.tsx `docs/main.ts` |\n')
    })

    it('escapes image alt text before rebuilding Markdown', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Image</th></tr></thead><tbody><tr><td></td></tr></tbody>'
        const image = document.createElement('img')
        image.setAttribute('src', 'https://example.com/table.png')
        image.setAttribute('alt', 'a]b' + '\\' + '|c')
        table.tBodies[0]!.rows[0]!.cells[0]!.append(image)

        const expectedAlt = 'a' + '\\]' + 'b' + '\\\\' + '\\|' + 'c'
        expect(serializeTableToMarkdown(table)).toBe(`| Image |\n| --- |\n| ![${expectedAlt}](https://example.com/table.png) |\n`)
    })

    it('keeps sanitized custom-link destinations available for Markdown copying', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'| Action |\n| --- |\n| [Open](custom://target) |'} />
            </I18nProvider>,
        )

        const link = screen.getByRole('link', { name: 'Open' })
        expect(link).toHaveAttribute('href', '#')
        expect(link).toHaveAttribute('data-hapi-markdown-href', 'custom://target')
        expect(serializeTableToMarkdown(screen.getByRole<HTMLTableElement>('table'))).toContain('[Open](custom://target)')
    })

    it('round-trips literal Markdown metacharacters in plain table text', () => {
        const source = '| Value |\n| --- |\n| \\*literal\\* \\_literal\\_ \\[brackets\\] \\`ticks\\` \\~\\~tilde\\~\\~ \\<angle\\> &amp;copy; |'
        const firstRender = render(
            <I18nProvider>
                <MarkdownRenderer standalone content={source} />
            </I18nProvider>,
        )

        const copied = serializeTableToMarkdown(screen.getByRole<HTMLTableElement>('table'))
        expect(copied).toContain('\\&copy;')
        firstRender.unmount()

        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={copied} />
            </I18nProvider>,
        )
        expect(screen.getByRole<HTMLTableElement>('table').tBodies[0]?.rows[0]?.cells[0]).toHaveTextContent('*literal* _literal_ [brackets] `ticks` ~~tilde~~ <angle> &copy;')
    })

    it('encodes Markdown link and image destinations with spaces and parentheses', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Value</th></tr></thead><tbody><tr><td></td></tr></tbody>'
        const cell = table.tBodies[0]!.rows[0]!.cells[0]!
        const link = document.createElement('a')
        link.dataset.hapiMarkdownHref = 'docs/My file (final).md'
        link.textContent = 'Spec'
        const image = document.createElement('img')
        image.setAttribute('src', 'https://example.com/My file (final).png')
        image.setAttribute('alt', 'Preview')
        cell.append(link, ' ', image)

        expect(serializeTableToMarkdown(table)).toBe('| Value |\n| --- |\n| [Spec](<docs/My file (final).md>) ![Preview](<https://example.com/My file (final).png>) |\n')
    })

    it('preserves Markdown column alignment when copying a table', () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th><th align="right">Stars</th><th style="text-align: center">Status</th></tr></thead><tbody><tr><td>HAPI</td><td>128</td><td>Active</td></tr></tbody>'

        expect(serializeTableToMarkdown(table)).toBe('| Project | Stars | Status |\n| --- | ---: | :---: |\n| HAPI | 128 | Active |\n')
    })

    it('downloads the rendered table as CSV and keeps its Blob URL alive briefly', () => {
        vi.useFakeTimers()
        const table = document.createElement('table')
        table.innerHTML = '<tr><td>HAPI</td></tr>'
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hapi-table')
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        let clickedRel: string | undefined
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clickedRel = this.rel
        })

        try {
            downloadTableAsCsv(table, 'repositories.csv')

            expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
            expect(click).toHaveBeenCalledTimes(1)
            expect(clickedRel).toBe('')
            expect(document.querySelector('a[download="repositories.csv"]')).toBeNull()
            expect(revokeObjectURL).not.toHaveBeenCalled()

            vi.advanceTimersByTime(999)
            expect(revokeObjectURL).not.toHaveBeenCalled()
            vi.advanceTimersByTime(1)
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:hapi-table')
        } finally {
            vi.useRealTimers()
        }
    })

    it('renders and downloads the table as a PNG image', async () => {
        const table = document.createElement('table')
        table.innerHTML = '<tr><td>HAPI</td></tr>'
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hapi-table-image')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

        await saveTableAsImage(table, 'repositories.png')

        expect(html2canvas).toHaveBeenCalledWith(expect.any(HTMLTableElement), expect.objectContaining({ useCORS: true }))
        expect(html2canvas.mock.calls[0]?.[0]).not.toBe(table)
        expect(click).toHaveBeenCalledTimes(1)
        expect(document.querySelector('a[download="repositories.png"]')).toBeNull()
    })

    it('renders a static table copy when the live header is sticky', async () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th></tr></thead><tbody><tr><td>HAPI</td></tr></tbody>'
        table.querySelector('thead')?.setAttribute('style', 'position: sticky; top: 0;')

        html2canvas.mockImplementation(async () => {
            return {
                toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
            }
        })

        await renderTableAsImage(table)

        const renderedTable = html2canvas.mock.calls[0]?.[0] as HTMLTableElement | undefined
        expect(renderedTable).toBeDefined()
        expect(renderedTable).not.toBe(table)
        expect(renderedTable?.querySelector('thead')?.getAttribute('style')).not.toContain('position: sticky')
        expect(document.querySelector('[data-hapi-table-image-render="true"]')).toBeNull()
        expect(table.querySelector('thead')).toHaveStyle({ position: 'sticky', top: '0px' })
    })

    it('preserves source column widths and header styling in the image clone', async () => {
        const table = document.createElement('table')
        table.innerHTML = '<thead><tr><th>Project</th><th>Status</th></tr></thead><tbody><tr><td>HAPI</td><td>Ready</td></tr></tbody>'
        table.style.backgroundColor = 'rgb(28, 28, 30)'
        table.tHead!.style.backgroundColor = 'rgb(53, 59, 67)'
        table.tHead!.rows[0]!.cells[0]!.style.backgroundColor = 'rgb(70, 70, 70)'
        table.tHead!.rows[0]!.cells[1]!.style.backgroundColor = 'rgb(80, 80, 80)'
        Object.defineProperty(table, 'scrollWidth', { configurable: true, value: 1_200 })
        vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({ top: 0, width: 1_200, height: 120 } as DOMRect)
        const rows = Array.from(table.rows)
        rows.forEach((row, rowIndex) => {
            vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: rowIndex * 60, bottom: (rowIndex + 1) * 60, height: 60 } as DOMRect)
            Array.from(row.cells).forEach((cell, cellIndex) => {
                vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
                    width: 600,
                    height: 60,
                    left: cellIndex * 600,
                    right: (cellIndex + 1) * 600,
                } as DOMRect)
            })
        })
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })

        await renderTableAsImage(table)

        const renderedTable = html2canvas.mock.calls[0]?.[0] as HTMLTableElement | undefined
        expect(renderedTable?.style.tableLayout).toBe('fixed')
        expect(Array.from(renderedTable?.querySelectorAll('col') ?? []).map((col) => col.style.width)).toEqual(['600px', '600px'])
        expect(renderedTable?.tHead?.style.backgroundColor).toBe('rgb(53, 59, 67)')
        expect(Array.from(renderedTable?.tHead?.querySelectorAll('th') ?? []).map((cell) => cell.style.backgroundColor)).toEqual([
            'rgb(70, 70, 70)',
            'rgb(80, 80, 80)',
        ])
    })

    it('crops trailing table box space from PNG exports', async () => {
        const table = document.createElement('table')
        table.innerHTML = '<tbody><tr><td>HAPI</td></tr></tbody>'
        Object.defineProperty(table, 'scrollHeight', { configurable: true, value: 844 })
        vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({
            top: 120,
            width: 1_851,
            height: 844,
        } as DOMRect)
        const row = table.querySelector('tr')
        vi.spyOn(row!, 'getBoundingClientRect').mockReturnValue({
            top: 120,
            bottom: 720,
            height: 600,
        } as DOMRect)
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })

        expect(getTableExportHeight(table)).toBe(600)
        await renderTableAsImage(table)

        const renderedTable = html2canvas.mock.calls[0]?.[0] as HTMLTableElement | undefined
        const options = html2canvas.mock.calls[0]?.[1] as { height: number } | undefined
        expect(options?.height).toBe(600)
        expect(renderedTable?.style.height).toBe('600px')
    })

    it('keeps export scale bounded and calculates safe vertical tiles', () => {
        const scale = getTableExportScale(10_000, 10_000, 1)
        expect(scale).toBeLessThan(1)
        expect(10_000 * 10_000 * scale ** 2).toBeLessThanOrEqual(MAX_TABLE_EXPORT_PIXELS)

        const tallScale = getTableExportScale(100, 100_000, 2)
        expect(Math.ceil(100 * tallScale)).toBeLessThanOrEqual(MAX_TABLE_EXPORT_DIMENSION)
        expect(Math.ceil(100_000 * tallScale)).toBeLessThanOrEqual(MAX_TABLE_EXPORT_DIMENSION)

        const tileHeight = getTableExportTileHeight(3_000, 2)
        expect(3_000 * tileHeight * 2 ** 2).toBeLessThanOrEqual(MAX_TABLE_EXPORT_TILE_PIXELS)
        expect(3_000 * (tileHeight + 1) * 2 ** 2).toBeGreaterThan(MAX_TABLE_EXPORT_TILE_PIXELS)
    })

    it('measures intrinsic width while a table is currently wrapped', () => {
        const table = document.createElement('table')
        const viewer = document.createElement('div')
        table.setAttribute('data-hapi-table-wrap', 'true')
        Object.defineProperty(viewer, 'clientWidth', { configurable: true, value: 150 })
        Object.defineProperty(table, 'scrollWidth', {
            configurable: true,
            get: () => table.hasAttribute('data-hapi-table-wrap') ? 150 : 200,
        })

        expect(shouldWrapTableByDefault(table, viewer)).toBe(true)
        expect(table.getAttribute('data-hapi-table-wrap')).toBe('true')
    })

    it('stitches oversized exports from bounded vertical tiles', async () => {
        const table = document.createElement('table')
        table.innerHTML = '<tr><td>HAPI</td></tr>'
        Object.defineProperty(table, 'scrollWidth', { configurable: true, value: 3_000 })
        Object.defineProperty(table, 'scrollHeight', { configurable: true, value: 4_000 })
        vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({ width: 3_000, height: 4_000 } as DOMRect)

        const originalDevicePixelRatio = window.devicePixelRatio
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
        const drawImage = vi.fn()
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
        const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
            callback(new Blob(['png'], { type: 'image/png' }))
        })
        html2canvas.mockImplementation(async (_element: HTMLElement, options: { width: number; height: number; scale: number }) => ({
            width: Math.ceil(options.width * options.scale),
            height: Math.ceil(options.height * options.scale),
            toBlob: (callback: BlobCallback) => callback(new Blob(['tile'], { type: 'image/png' })),
        }))

        try {
            await renderTableAsImage(table)

            const expectedTiles = Math.ceil(4_000 / getTableExportTileHeight(3_000, getTableExportScale(3_000, 4_000, 2)))
            expect(html2canvas).toHaveBeenCalledTimes(expectedTiles)
            expect(drawImage).toHaveBeenCalledTimes(expectedTiles)
            const scale = getTableExportScale(3_000, 4_000, 2)
            const destinationRanges = drawImage.mock.calls.map((call) => ({
                top: call[6] as number,
                bottom: (call[6] as number) + (call[8] as number),
            }))
            for (let index = 1; index < destinationRanges.length; index += 1) {
                expect(destinationRanges[index - 1]?.bottom).toBe(destinationRanges[index]?.top)
            }
            expect(destinationRanges.at(-1)?.bottom).toBe(Math.ceil(4_000 * scale))
            expect(toBlob).toHaveBeenCalledTimes(1)
            expect(getContext).toHaveBeenCalledWith('2d')
            expect(document.querySelector('[data-hapi-table-image-render="true"]')).toBeNull()
        } finally {
            Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: originalDevicePixelRatio })
        }
    })

    it('keeps the stitched PNG canvas within the browser dimension limit', async () => {
        const table = document.createElement('table')
        table.innerHTML = '<tr><td>HAPI</td></tr>'
        Object.defineProperty(table, 'scrollWidth', { configurable: true, value: 1_000 })
        Object.defineProperty(table, 'scrollHeight', { configurable: true, value: 20_000 })
        vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({ width: 1_000, height: 20_000 } as DOMRect)

        const createdCanvases: HTMLCanvasElement[] = []
        const createElement = document.createElement.bind(document)
        vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
            const element = createElement(tagName, options)
            if (tagName === 'canvas') createdCanvases.push(element as HTMLCanvasElement)
            return element
        })
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
            callback(new Blob(['png'], { type: 'image/png' }))
        })
        html2canvas.mockImplementation(async (_element: HTMLElement, options: { width: number; height: number; scale: number }) => ({
            width: Math.ceil(options.width * options.scale),
            height: Math.ceil(options.height * options.scale),
            toBlob: (callback: BlobCallback) => callback(new Blob(['tile'], { type: 'image/png' })),
        }))

        await renderTableAsImage(table)

        expect(createdCanvases).toHaveLength(1)
        expect(Math.max(createdCanvases[0]?.width ?? 0, createdCanvases[0]?.height ?? 0)).toBeLessThanOrEqual(MAX_TABLE_EXPORT_DIMENSION)
    })

    it('uses the same direct download path on touch devices as shared images', () => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        })) as typeof window.matchMedia

        const share = vi.fn().mockResolvedValue(undefined)
        const canShare = vi.fn().mockReturnValue(true)
        Object.defineProperty(navigator, 'share', { configurable: true, value: share })
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare })

        const table = document.createElement('table')
        table.innerHTML = '<tr><td>HAPI</td></tr>'
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
        downloadTableAsCsv(table, 'repositories.csv')

        expect(canShare).not.toHaveBeenCalled()
        expect(share).not.toHaveBeenCalled()
        expect(click).toHaveBeenCalledTimes(1)
    })
})
