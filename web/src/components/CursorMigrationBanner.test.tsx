import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { CursorMigrationBanner, isCursorMigrationAmbiguous, isCursorMigrationInProgress } from './CursorMigrationBanner'
import type { Metadata } from '@/types/api'

function renderWithProviders(ui: React.ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

afterEach(() => {
    cleanup()
})

function metadata(partial: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp/x',
        host: 'localhost',
        ...partial
    } as Metadata
}

describe('isCursorMigrationInProgress', () => {
    it('returns true when flag is in_progress', () => {
        expect(isCursorMigrationInProgress(metadata({ cursorMigrationState: 'in_progress' }))).toBe(true)
    })
    it('returns false when flag is undefined', () => {
        expect(isCursorMigrationInProgress(metadata())).toBe(false)
    })
    it('returns false when metadata is null', () => {
        expect(isCursorMigrationInProgress(null)).toBe(false)
    })
    it('returns false when metadata is undefined', () => {
        expect(isCursorMigrationInProgress(undefined)).toBe(false)
    })
})

describe('CursorMigrationBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        Object.defineProperty(window, 'localStorage', {
            value: {
                getItem: vi.fn(() => 'en'),
                setItem: vi.fn(),
                removeItem: vi.fn(),
                clear: vi.fn(),
                key: vi.fn(() => null),
                length: 0
            },
            configurable: true
        })
    })

    it('renders the banner when cursorMigrationState is in_progress', () => {
        renderWithProviders(<CursorMigrationBanner metadata={metadata({ cursorMigrationState: 'in_progress' })} />)
        expect(screen.getByTestId('cursor-migration-banner')).toBeInTheDocument()
        expect(screen.getByText('Upgrading Cursor session')).toBeInTheDocument()
        expect(screen.getByText(/safer ACP protocol/)).toBeInTheDocument()
    })

    it('does not render when cursorMigrationState is undefined', () => {
        renderWithProviders(<CursorMigrationBanner metadata={metadata()} />)
        expect(screen.queryByTestId('cursor-migration-banner')).not.toBeInTheDocument()
    })

    it('does not render when metadata is null', () => {
        renderWithProviders(<CursorMigrationBanner metadata={null} />)
        expect(screen.queryByTestId('cursor-migration-banner')).not.toBeInTheDocument()
    })

    it('does not render when metadata is undefined', () => {
        renderWithProviders(<CursorMigrationBanner metadata={undefined} />)
        expect(screen.queryByTestId('cursor-migration-banner')).not.toBeInTheDocument()
    })

    it('does not render when migration is complete (cursorSessionProtocol is acp but no in_progress flag)', () => {
        renderWithProviders(<CursorMigrationBanner metadata={metadata({ cursorSessionProtocol: 'acp' })} />)
        expect(screen.queryByTestId('cursor-migration-banner')).not.toBeInTheDocument()
    })

    it('uses role=status and aria-live=polite for screen-reader accessibility', () => {
        renderWithProviders(<CursorMigrationBanner metadata={metadata({ cursorMigrationState: 'in_progress' })} />)
        const status = screen.getByRole('status')
        expect(status).toHaveAttribute('aria-live', 'polite')
    })

    /**
     * tiann/hapi#873: when the migrator refuses to transplant a legacy
     * store (ambiguous source or size mismatch), the hub promotes
     * cursorMigrationState to 'ambiguous'. The banner must switch to a
     * "manual review needed" surface rather than disappear.
     */
    it('renders the ambiguous banner when cursorMigrationState is ambiguous', () => {
        renderWithProviders(<CursorMigrationBanner metadata={metadata({ cursorMigrationState: 'ambiguous' })} />)
        expect(screen.getByTestId('cursor-migration-banner-ambiguous')).toBeInTheDocument()
        expect(screen.getByText('Cursor session upgrade needs manual review')).toBeInTheDocument()
        expect(screen.queryByTestId('cursor-migration-banner')).not.toBeInTheDocument()
    })

    it('uses role=alert on the ambiguous banner so it surfaces over the in-progress styling', () => {
        renderWithProviders(<CursorMigrationBanner metadata={metadata({ cursorMigrationState: 'ambiguous' })} />)
        const alert = screen.getByRole('alert')
        expect(alert).toHaveAttribute('aria-live', 'polite')
    })

    it('isCursorMigrationAmbiguous returns true only for the ambiguous state', () => {
        expect(isCursorMigrationAmbiguous(metadata({ cursorMigrationState: 'ambiguous' }))).toBe(true)
        expect(isCursorMigrationAmbiguous(metadata({ cursorMigrationState: 'in_progress' }))).toBe(false)
        expect(isCursorMigrationAmbiguous(metadata())).toBe(false)
        expect(isCursorMigrationAmbiguous(null)).toBe(false)
        expect(isCursorMigrationAmbiguous(undefined)).toBe(false)
    })
})
