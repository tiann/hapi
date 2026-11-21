import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ExternalRef } from '@hapi/protocol/types'
import { I18nProvider } from '@/lib/i18n-context'
import { IssueRefChip } from './IssueRefChip'

const REF: ExternalRef = { kind: 'github_issue', url: 'https://github.com/heavygee/hapi/issues/238', repo: 'heavygee/hapi', number: 238, linkedAt: 1 }

describe('IssueRefChip', () => {
    it('links the issue number straight out to GitHub', () => {
        render(<I18nProvider><IssueRefChip ref={REF} /></I18nProvider>)
        const link = screen.getByTestId('issue-ref-chip')
        expect(link).toHaveAttribute('href', REF.url)
        expect(link).toHaveTextContent('#238')
    })

    it('does not render a board affordance when there is no board match', () => {
        render(<I18nProvider><IssueRefChip ref={REF} /></I18nProvider>)
        expect(screen.queryByTestId('issue-ref-chip-board-link')).toBeNull()
    })

    it('does not render a board affordance when a match exists but no onOpenBoardItem callback is given', () => {
        render(<I18nProvider><IssueRefChip ref={REF} boardMatch={{ boardId: 'b1', boardLabel: 'Demo', itemId: 'i1' }} /></I18nProvider>)
        expect(screen.queryByTestId('issue-ref-chip-board-link')).toBeNull()
    })

    it('renders a board affordance and fires onOpenBoardItem with the match, without following the GitHub link', () => {
        const onOpenBoardItem = vi.fn()
        const match = { boardId: 'b1', boardLabel: 'Demo Board', itemId: 'i1' }
        render(<I18nProvider><IssueRefChip ref={REF} boardMatch={match} onOpenBoardItem={onOpenBoardItem} /></I18nProvider>)

        const boardButton = screen.getByTestId('issue-ref-chip-board-link')
        expect(boardButton).toHaveAttribute('aria-label', 'Open on the "Demo Board" board')
        fireEvent.click(boardButton)
        expect(onOpenBoardItem).toHaveBeenCalledWith(match)
    })
})
