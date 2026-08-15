import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DshImportActions } from './DshImportActions'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('DshImportActions', () => {
    it('opens the local DeepSeek Harness history picker', () => {
        const onChooseHistory = vi.fn()
        render(
            <DshImportActions
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'dshImport.inline.choose' }))
        expect(onChooseHistory).toHaveBeenCalledOnce()
    })
})
