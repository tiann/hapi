import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgentSelector } from './AgentSelector'
import type { AgentType } from './types'

function renderedAgentValues(): string[] {
    const { container } = render(
        <AgentSelector agent={'claude' as AgentType} isDisabled={false} onAgentChange={() => {}} />
    )
    return Array.from(container.querySelectorAll('input[type="radio"]'))
        .map((el) => (el as HTMLInputElement).value)
}

describe('AgentSelector', () => {
    it('does not offer the sunset Gemini CLI as a new-session agent', () => {
        expect(renderedAgentValues()).not.toContain('gemini')
    })

    it('offers exactly the creatable agent flavors', () => {
        expect(renderedAgentValues()).toEqual([...CREATABLE_AGENT_FLAVORS])
    })
})
