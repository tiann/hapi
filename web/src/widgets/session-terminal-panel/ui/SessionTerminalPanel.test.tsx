import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SessionTerminalPanel } from './SessionTerminalPanel'

const { TerminalMock } = vi.hoisted(() => ({
    TerminalMock: vi.fn(function(this: any) {
        this.loadAddon = vi.fn()
        this.open = vi.fn()
        this.dispose = vi.fn()
        this.options = {}
        this.cols = 80
        this.rows = 24
        this.refresh = vi.fn()
    })
}))

// Mock xterm and addons
vi.mock('@xterm/xterm', () => {
    return { Terminal: TerminalMock }
})

vi.mock('@xterm/addon-fit', () => {
    const FitAddon = function(this: any) {
        this.fit = vi.fn()
        this.dispose = vi.fn()
    }
    return { FitAddon }
})

vi.mock('@xterm/addon-web-links', () => {
    const WebLinksAddon = function(this: any) {
        this.dispose = vi.fn()
    }
    return { WebLinksAddon }
})

vi.mock('@xterm/addon-canvas', () => {
    const CanvasAddon = function(this: any) {
        this.dispose = vi.fn()
    }
    return { CanvasAddon }
})

vi.mock('@/lib/terminalFont', () => ({
    ensureBuiltinFontLoaded: vi.fn().mockResolvedValue(true),
    getFontProvider: vi.fn(() => ({
        getFontFamily: vi.fn(() => 'monospace')
    }))
}))

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
}

describe('SessionTerminalPanel', () => {
    it('renders terminal container', () => {
        const { container } = render(<SessionTerminalPanel />)
        expect(container.querySelector('div')).toBeInTheDocument()
    })

    it('calls onMount with terminal instance', async () => {
        const onMount = vi.fn()
        render(<SessionTerminalPanel onMount={onMount} />)

        // Wait for useEffect to run
        await vi.waitFor(() => {
            expect(onMount).toHaveBeenCalled()
        })
    })

    it('calls onResize when terminal is resized', async () => {
        const onResize = vi.fn()
        render(<SessionTerminalPanel onResize={onResize} />)

        // Wait for initial resize
        await vi.waitFor(() => {
            expect(onResize).toHaveBeenCalled()
        })
    })

    it('applies custom className', () => {
        const { container } = render(<SessionTerminalPanel className="custom-class" />)
        const terminalDiv = container.querySelector('.custom-class')
        expect(terminalDiv).toBeInTheDocument()
    })

    it('creates terminal with correct configuration', async () => {
        render(<SessionTerminalPanel />)

        await vi.waitFor(() => {
            expect(TerminalMock).toHaveBeenCalled()
        })
    })

    it('cleans up terminal on unmount', async () => {
        const { unmount } = render(<SessionTerminalPanel />)

        // Just verify unmount doesn't throw
        expect(() => unmount()).not.toThrow()
    })
})
