import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { ModelSelector } from './ModelSelector'

const baseProps = {
    agent: 'pi' as const,
    model: 'auto',
    isDisabled: false,
    onModelChange: vi.fn(),
}

describe('ModelSelector', () => {
    it('renders provider-grouped options as optgroups', () => {
        const { container } = render(
            <ModelSelector
                {...baseProps}
                options={[
                    { value: 'auto', label: 'Default' },
                    { value: 'openai-codex/gpt-5.6-sol', label: 'gpt-5.6-sol', group: 'Openai-codex' },
                    { value: 'opencode-go/gpt-5.6-sol', label: 'gpt-5.6-sol', group: 'Opencode-go' },
                ]}
            />
        )
        const groups = container.querySelectorAll('optgroup')
        expect(groups).toHaveLength(2)
        expect(groups[0]?.getAttribute('label')).toBe('Openai-codex')
        expect(groups[1]?.getAttribute('label')).toBe('Opencode-go')
        // Identical labels from different providers stay distinct options.
        expect(container.querySelectorAll('option')).toHaveLength(3)
    })

    it('renders ungrouped options as plain options', () => {
        const { container } = render(
            <ModelSelector
                {...baseProps}
                options={[
                    { value: 'auto', label: 'Default' },
                    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
                ]}
            />
        )
        expect(container.querySelectorAll('optgroup')).toHaveLength(0)
        expect(container.querySelectorAll('option')).toHaveLength(2)
    })

    it('renders nothing when options are empty', () => {
        const { container } = render(<ModelSelector {...baseProps} options={[]} />)
        expect(container.querySelector('select')).toBeNull()
    })
})
