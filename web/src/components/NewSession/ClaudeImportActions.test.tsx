import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeImportActions } from './ClaudeImportActions'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('ClaudeImportActions', () => {
    it('opens the local Claude history picker', () => {
        const onChooseHistory = vi.fn()
        render(
            <ClaudeImportActions
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'claudeImport.inline.choose' }))
        expect(onChooseHistory).toHaveBeenCalledOnce()
    })
})