import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { AgentSelector } from './AgentSelector'
import type { AgentDescriptor } from '@hapi/protocol/plugins'

function renderSelector(props: Partial<Parameters<typeof AgentSelector>[0]> = {}) {
    const onAgentChange = vi.fn()
    const agents: AgentDescriptor[] = [
        {
            id: 'claude',
            displayName: 'Claude',
            source: 'builtin',
            adapter: { runtime: 'runner', kind: 'stdio', contributionId: 'builtin:claude' },
            capabilities: { permissionModes: ['default'] },
            available: true
        },
        {
            id: 'vendor:example-agent',
            displayName: 'Example Agent',
            source: 'plugin',
            pluginId: 'com.example.agent',
            adapter: { runtime: 'runner', kind: 'custom-runner-plugin', contributionId: 'example-adapter' },
            capabilities: { permissionModes: ['default', 'yolo'], models: ['example-large'] },
            available: true
        },
        {
            id: 'vendor:missing-agent',
            displayName: 'Missing Agent',
            source: 'plugin',
            pluginId: 'com.example.missing',
            adapter: { runtime: 'runner', kind: 'custom-runner-plugin', contributionId: 'missing-adapter' },
            capabilities: { permissionModes: ['default'] },
            available: false,
            unavailableReason: 'Plugin disabled'
        }
    ]

    render(
        <I18nProvider>
            <AgentSelector
                agent="claude"
                agents={agents}
                isDisabled={false}
                onAgentChange={onAgentChange}
                {...props}
            />
        </I18nProvider>
    )
    return { onAgentChange }
}

describe('AgentSelector', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders built-in and plugin agent descriptors', () => {
        renderSelector()

        expect(screen.getByLabelText('Claude')).toBeInTheDocument()
        expect(screen.getByLabelText('Example Agent')).toBeInTheDocument()
        expect(screen.getByLabelText('Missing Agent')).toBeDisabled()
    })

    it('emits the plugin agent id when selected', () => {
        const { onAgentChange } = renderSelector()

        fireEvent.click(screen.getByLabelText('Example Agent'))

        expect(onAgentChange).toHaveBeenCalledWith('vendor:example-agent')
    })
})
