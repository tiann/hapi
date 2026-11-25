import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CursorImportActions } from './CursorImportActions'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('CursorImportActions', () => {
    it('opens the local Cursor history picker', () => {
        const onChooseHistory = vi.fn()
        render(
            <CursorImportActions
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'cursorImport.inline.choose' }))
        expect(onChooseHistory).toHaveBeenCalledOnce()
    })
})
