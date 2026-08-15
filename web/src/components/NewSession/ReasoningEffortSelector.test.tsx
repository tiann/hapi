import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { ReasoningEffortSelector } from './ReasoningEffortSelector'

describe('ReasoningEffortSelector', () => {
    it('hides DSH reasoning when the selected model advertises no choices', () => {
        const { container } = render(
            <ReasoningEffortSelector
                agent="dsh"
                value="default"
                availableOptions={[]}
                isDisabled={false}
                onChange={vi.fn()}
            />
        )

        expect(container.firstChild).toBeNull()
    })

    it('renders only the reasoning choices advertised by DSH', () => {
        render(
            <ReasoningEffortSelector
                agent="dsh"
                value="default"
                availableOptions={[{ value: 'max', name: 'Maximum' }]}
                isDisabled={false}
                onChange={vi.fn()}
            />
        )

        expect(screen.getAllByRole('option').map((option) => option.getAttribute('value')))
            .toEqual(['default', 'max'])
        expect(screen.queryByRole('option', { name: 'High' })).toBeNull()
    })
})
