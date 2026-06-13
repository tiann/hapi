import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ScratchlistMigrationBanner } from './ScratchlistMigrationBanner'

afterEach(() => cleanup())

function renderBanner(props: {
    migrationStatus: 'idle' | 'migrating' | 'completed' | 'dismissed'
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

    // 'pre-migrated' was removed by the HAPI Bot PR #896 follow-up:
    // a session whose migration ran in a prior mount but was not yet
    // dismissed should now show the banner, not hide it. The
    // dismissal flag is the only thing that suppresses the banner -
    // see ScratchlistMigrationBanner doc-comment.

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
