import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OpencodeImportActions } from './OpencodeImportActions'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('OpencodeImportActions', () => {
    it('opens the local OpenCode history picker', () => {
        const onChooseHistory = vi.fn()
        render(
            <OpencodeImportActions
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'opencodeSync.inline.choose' }))
        expect(onChooseHistory).toHaveBeenCalledOnce()
    })
})
