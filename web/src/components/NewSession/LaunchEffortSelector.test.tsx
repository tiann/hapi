import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { LaunchEffortSelector } from './LaunchEffortSelector'

describe('LaunchEffortSelector', () => {
    it('renders Grok low/medium/high effort and forwards the selection', () => {
        const onChange = vi.fn()
        const { container } = render(
            <LaunchEffortSelector
                agent="grok"
                effort="auto"
                isDisabled={false}
                onEffortChange={onChange}
            />
        )
        const select = container.querySelector('select') as HTMLSelectElement

        expect(Array.from(select.options).map((option) => option.value)).toEqual([
            'auto', 'low', 'medium', 'high'
        ])
        fireEvent.change(select, { target: { value: 'low' } })
        expect(onChange).toHaveBeenCalledWith('low')
    })
})
