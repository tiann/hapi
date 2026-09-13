import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { FileActionMenu } from '@/components/FileActionMenu'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn(), impact: vi.fn() },
    }),
}))

function renderMenu(overrides: Partial<React.ComponentProps<typeof FileActionMenu>> = {}) {
    const defaults: React.ComponentProps<typeof FileActionMenu> = {
        isOpen: true,
        onClose: vi.fn(),
        relativePath: 'src/foo.ts',
        absolutePath: '/home/me/project/src/foo.ts',
        anchorPoint: { x: 40, y: 40 },
        onAddToComposer: vi.fn(),
    }
    const props = { ...defaults, ...overrides }
    return {
        ...render(
            <I18nProvider>
                <FileActionMenu {...props} />
            </I18nProvider>
        ),
        props,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('FileActionMenu', () => {
    it('renders the three file actions', () => {
        renderMenu()

        expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Copy absolute path' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Add to composer' })).toBeInTheDocument()
    })

    it('renders nothing when closed', () => {
        renderMenu({ isOpen: false })

        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('copies the relative path and closes', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })
        const onClose = vi.fn()
        renderMenu({ onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))

        expect(onClose).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('src/foo.ts'))
    })

    it('copies the absolute path and closes', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })
        const onClose = vi.fn()
        renderMenu({ onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy absolute path' }))

        expect(onClose).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('/home/me/project/src/foo.ts'))
    })

    it('adds the file to the composer and closes', () => {
        const onAddToComposer = vi.fn()
        const onClose = vi.fn()
        renderMenu({ onAddToComposer, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to composer' }))

        expect(onAddToComposer).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('closes on Escape', () => {
        const onClose = vi.fn()
        renderMenu({ onClose })

        fireEvent.keyDown(document, { key: 'Escape' })

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('closes on an outside pointer down', () => {
        const onClose = vi.fn()
        renderMenu({ onClose })

        fireEvent.pointerDown(document.body)

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('anchors the left edge at the pointer instead of centering on it', () => {
        const originalInnerWidth = window.innerWidth
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
        const menuRect = {
            bottom: 200,
            height: 200,
            left: 0,
            right: 240,
            top: 0,
            width: 240,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        } as DOMRect
        const getBoundingClientRect = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue(menuRect)

        try {
            renderMenu({ anchorPoint: { x: 800, y: 300 } })

            expect(screen.getByRole('menu').parentElement).toHaveStyle({ left: '800px' })
        } finally {
            getBoundingClientRect.mockRestore()
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
        }
    })
})
