import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { OpencodeAgentSelector } from './OpencodeAgentSelector'

describe('OpencodeAgentSelector', () => {
    it('renders discovered agents and reports selection changes', () => {
        const onChange = vi.fn()
        render(<I18nProvider>
            <OpencodeAgentSelector
                value="build"
                availableAgents={[
                    { agentId: 'build', name: 'build' },
                    { agentId: 'plan', name: 'plan' }
                ]}
                isDisabled={false}
                onChange={onChange}
            />
        </I18nProvider>)

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
        expect(onChange).toHaveBeenCalledWith('plan')
    })

    it('renders nothing when no agents were discovered', () => {
        const { container } = render(<I18nProvider>
            <OpencodeAgentSelector
                value={null}
                availableAgents={[]}
                isDisabled={false}
                onChange={() => {}}
            />
        </I18nProvider>)

        expect(container).toBeEmptyDOMElement()
    })
})
