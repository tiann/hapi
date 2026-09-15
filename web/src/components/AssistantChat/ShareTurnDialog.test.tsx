import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ShareTurnDialog } from './ShareTurnDialog'

vi.mock('html2canvas-pro', () => ({
    default: vi.fn(async () => ({
        toBlob(callback: BlobCallback) {
            callback(new Blob(['png'], { type: 'image/png' }))
        },
    })),
}))

afterEach(() => cleanup())

describe('ShareTurnDialog', () => {
    it('gives the icon-only Agent metadata an accessible name', () => {
        render(
            <I18nProvider>
                <ShareTurnDialog
                    isOpen={true}
                    title="Shared turn"
                    metadataItems={[{
                        key: 'agent',
                        text: 'codex',
                        flavor: 'codex',
                        showIcon: true,
                        showText: false,
                    }]}
                    sourceSnapshots={[]}
                    onClose={vi.fn()}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('img', { name: 'codex' })).toBeInTheDocument()
    })
})
