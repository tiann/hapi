import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ScratchlistMigrationBanner } from './ScratchlistMigrationBanner'

afterEach(() => cleanup())

function renderBanner(props: {
    migrationStatus: 'idle' | 'migrating' | 'completed' | 'dismissed' | 'pre-migrated'
    onDismiss?: () => void
}) {
    return render(
        <I18nProvider>
            <ScratchlistMigrationBanner
                migrationStatus={props.migrationStatus}
                onDismiss={props.onDismiss ?? vi.fn()}
            />
        </I18nProvider>
    )
}

describe('ScratchlistMigrationBanner', () => {
    it('renders nothing in idle state', () => {
        const { container } = renderBanner({ migrationStatus: 'idle' })
        expect(container.firstChild).toBeNull()
    })

    it('renders nothing while the migration is in flight', () => {
        const { container } = renderBanner({ migrationStatus: 'migrating' })
        expect(container.firstChild).toBeNull()
    })

    it('renders nothing for the dismissed state', () => {
        const { container } = renderBanner({ migrationStatus: 'dismissed' })
        expect(container.firstChild).toBeNull()
    })

    it('renders nothing for pre-migrated sessions (operator already saw the banner once)', () => {
        const { container } = renderBanner({ migrationStatus: 'pre-migrated' })
        expect(container.firstChild).toBeNull()
    })

    it('renders the banner with title, body, and dismiss button when status is completed', () => {
        renderBanner({ migrationStatus: 'completed' })
        expect(screen.getByTestId('scratchlist-migration-banner')).toBeTruthy()
        // Title contains the cross-device cue.
        expect(screen.getByText(/syncs across devices/i)).toBeTruthy()
        // Body contains the "nothing was lost" reassurance.
        expect(screen.getByText(/nothing was lost/i)).toBeTruthy()
        // Dismiss button exists.
        expect(screen.getByTestId('scratchlist-migration-banner-dismiss')).toBeTruthy()
    })

    it('calls onDismiss when the dismiss button is clicked', () => {
        const onDismiss = vi.fn()
        renderBanner({ migrationStatus: 'completed', onDismiss })
        fireEvent.click(screen.getByTestId('scratchlist-migration-banner-dismiss'))
        expect(onDismiss).toHaveBeenCalledTimes(1)
    })
})
