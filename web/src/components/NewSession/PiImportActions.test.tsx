import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PiImportActions } from './PiImportActions'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('PiImportActions', () => {
    it('opens the local Pi history picker', () => {
        const onChooseHistory = vi.fn()
        render(
            <PiImportActions
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        expect(onChooseHistory).toHaveBeenCalledOnce()
    })
})
