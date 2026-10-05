import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ShareTurnDialog } from '@/components/AssistantChat/ShareTurnDialog'

describe('ShareTurnDialog display-links exact-copy', () => {
    const matchMedia = window.matchMedia

    beforeEach(() => {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })) as unknown as typeof window.matchMedia
    })

    afterEach(() => {
        window.matchMedia = matchMedia
    })

    it('strips exact-copy secret rows from the share capture while keeping URL rows', async () => {
        const secret = 'SENTINEL_SECRET_VK' + 'K'
        const html = [
            '<div data-hapi-message-role="assistant">',
            '<div data-testid="display-links-card">',
            '<a data-testid="display-links-href">Public issue</a>',
            `<li data-hapi-share-exclude="true"><button data-testid="display-links-text">${secret}</button></li>`,
            '</div>',
            '</div>',
        ].join('')

        render(
            <I18nProvider>
                <ShareTurnDialog
                    isOpen
                    title="Share turn"
                    metadataItems={[]}
                    sourceSnapshots={[{
                        html,
                        text: `Public issue ${secret}`,
                        role: 'assistant',
                    }]}
                    onClose={() => {}}
                />
            </I18nProvider>
        )

        await waitFor(() => {
            expect(document.body.textContent).toContain('Public issue')
        })
        expect(document.body.textContent).not.toContain(secret)
    })
})
