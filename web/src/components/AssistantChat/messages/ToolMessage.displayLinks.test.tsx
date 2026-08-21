import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { DisplayLinksCard } from '@/components/AssistantChat/messages/ToolMessage'
import type { DisplayLinksBlock } from '@/chat/types'

function renderCard(block: DisplayLinksBlock) {
    return render(
        <I18nProvider>
            <DisplayLinksCard block={block} />
        </I18nProvider>
    )
}

describe('DisplayLinksCard', () => {
    it('paints the constructed href without reconstructing from prose', () => {
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'
        renderCard({
            kind: 'display-links',
            id: 'block-1',
            localId: null,
            createdAt: 1,
            urls: [{ href, title: 'Issue 1516' }],
        })

        const link = screen.getByRole('link', { name: /Issue 1516/ })
        expect(link).toHaveAttribute('href', 'https://github.com/tiann/hapi/issues/1516')
        expect(link.getAttribute('href')).toBe(href)
        expect(link.getAttribute('href')).not.toContain('tian/hapi')
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('uses unique keys when two cards share an href with different titles', () => {
        const href = 'https://example.com/same'
        renderCard({
            kind: 'display-links',
            id: 'block-dup',
            localId: null,
            createdAt: 1,
            urls: [
                { href, title: 'First' },
                { href, title: 'Second' },
            ],
        })

        const links = screen.getAllByRole('link')
        expect(links).toHaveLength(2)
        expect(links[0]).toHaveAttribute('href', href)
        expect(links[1]).toHaveAttribute('href', href)
        expect(screen.getByRole('link', { name: /First/ })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Second/ })).toBeInTheDocument()
    })

    it('paints concatenated exact-copy bytes on a copy control, not as a link', async () => {
        const value = 'VK' + 'K'
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.assign(navigator, { clipboard: { writeText } })

        renderCard({
            kind: 'display-links',
            id: 'block-text',
            localId: null,
            createdAt: 1,
            urls: [],
            texts: [{ value, title: 'gate' }],
        })

        expect(screen.queryByRole('link')).not.toBeInTheDocument()
        const copyButton = screen.getByRole('button', { name: /copy gate/i })
        expect(copyButton).toHaveAttribute('data-copy-value', 'VKK')
        expect(copyButton.getAttribute('data-copy-value')).toBe(value)
        expect(copyButton.getAttribute('data-copy-value')).not.toBe('VK')
        expect(screen.getByTestId('display-links-text')).toHaveTextContent('VKK')
        expect(copyButton.closest('li')).toHaveAttribute('data-hapi-share-exclude', 'true')

        fireEvent.click(copyButton)
        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith(value)
        })
    })

    it('does not make javascript hrefs tappable', () => {
        renderCard({
            kind: 'display-links',
            id: 'block-evil',
            localId: null,
            createdAt: 1,
            urls: [{ href: 'javascript:alert(1)', title: 'evil' }],
        })

        expect(screen.queryByRole('link')).not.toBeInTheDocument()
        expect(screen.getByText('evil')).toBeInTheDocument()
    })
})
