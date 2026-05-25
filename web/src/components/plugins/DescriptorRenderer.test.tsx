import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { PluginDescriptorPanels } from './DescriptorRenderer'
import { PluginWebContributionsSchema } from '@hapi/protocol/plugins'
import { I18nProvider } from '@/lib/i18n-context'

function renderPanels(props: React.ComponentProps<typeof PluginDescriptorPanels>) {
    return render(
        <I18nProvider>
            <PluginDescriptorPanels {...props} />
        </I18nProvider>
    )
}

describe('PluginDescriptorPanels', () => {
    it('renders supported descriptor components and dispatches allowlisted actions', async () => {
        const onAction = vi.fn()
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'status',
                    title: 'Status',
                    components: [
                        { kind: 'text', text: 'Ready' },
                        { kind: 'badge', label: 'Active', variant: 'success' },
                        { kind: 'actionButton', id: 'reload', label: 'Reload', actionId: 'plugin.reload' },
                        { kind: 'actionButton', id: 'test', label: 'Test push', actionId: 'plugin.notificationTest', variant: 'secondary' }
                    ]
                }]
            },
            onAction
        })

        expect(screen.getByText('Ready')).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
        await waitFor(() => expect(onAction).toHaveBeenCalledWith('plugin.reload'))
        fireEvent.click(screen.getByRole('button', { name: 'Test push' }))
        await waitFor(() => expect(onAction).toHaveBeenCalledWith('plugin.notificationTest'))
    })

    it('rejects unknown component kinds locally without hiding valid sibling components', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'bad',
                    title: 'Bad',
                    components: [
                        { kind: 'text', text: 'Still visible' },
                        { kind: 'iframe', src: 'javascript:alert(1)' }
                    ]
                }]
            }
        })

        expect(screen.getByText('Still visible')).toBeInTheDocument()
        expect(screen.getByText('Plugin descriptor component failed validation.')).toBeInTheDocument()
    })

    it('rejects arbitrary action URLs or JavaScript handlers in protocol schema', () => {
        const parsed = PluginWebContributionsSchema.safeParse({
            settingsPanels: [{
                id: 'bad-action',
                title: 'Bad action',
                components: [{
                    kind: 'actionButton',
                    label: 'Open',
                    actionId: 'https://evil.example/run',
                    url: 'javascript:alert(1)'
                }]
            }]
        })

        expect(parsed.success).toBe(false)
    })

    it('does not render secret values from config in schema forms', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'config',
                    title: 'Config',
                    components: [{
                        kind: 'schemaForm',
                        id: 'form',
                        fields: [
                            { key: 'apiToken', label: 'API token', type: 'text', secret: true },
                            { key: 'label', label: 'Label', type: 'text' }
                        ]
                    }]
                }]
            },
            config: { apiToken: 'secret-value', label: 'Visible value' }
        })

        expect(screen.queryByDisplayValue('secret-value')).not.toBeInTheDocument()
        expect(screen.getByDisplayValue('Visible value')).toBeInTheDocument()
    })

    it('renders JSON-like text fields as mobile-friendly multiline editors', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'json-settings',
                    title: 'JSON Settings',
                    components: [{
                        kind: 'schemaForm',
                        id: 'advanced',
                        title: 'Advanced rules JSON',
                        description: 'JSON array, e.g. [{"name":"example","directoryPrefixes":["/repo"]}].',
                        fields: [
                            { key: 'rulesJson', label: 'rulesJson', type: 'text' }
                        ]
                    }]
                }]
            },
            config: { rulesJson: '[{"name":"example"}]' }
        })

        const editor = screen.getByLabelText('rulesJson')
        expect(editor.tagName).toBe('TEXTAREA')
        expect(editor).toHaveClass('min-w-0')
        expect(screen.getByText(/JSON array/)).toHaveClass('[overflow-wrap:anywhere]')
    })

    it('renders boolean schema fields as compact single-row controls', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'events',
                    title: 'Events',
                    components: [{
                        kind: 'schemaForm',
                        id: 'event-switches',
                        fields: [
                            { key: 'notifyReady', label: 'Ready-for-input events', type: 'boolean', defaultValue: true },
                            { key: 'notifyPermissionRequest', label: 'Permission requests', type: 'boolean', defaultValue: true }
                        ]
                    }]
                }]
            }
        })

        const readyRow = screen.getByLabelText('Ready-for-input events').closest('label')
        expect(readyRow).toHaveClass('flex')
        expect(readyRow).not.toHaveClass('space-y-1')
    })

    it('renders selectable multi-value fields from option sources and saves arrays', async () => {
        const onSaveConfig = vi.fn()
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'notifications',
                    title: 'Notifications',
                    components: [{
                        kind: 'schemaForm',
                        id: 'scope',
                        title: 'Scope',
                        fields: [
                            {
                                key: 'agentNames',
                                label: 'Agents',
                                type: 'multiSelect',
                                optionsSource: 'notification.agents'
                            }
                        ]
                    }]
                }]
            },
            optionSources: {
                'notification.agents': [
                    { value: 'Codex', label: 'Codex', description: '2 sessions' },
                    { value: 'Claude', label: 'Claude', description: '1 session' }
                ]
            },
            onSaveConfig
        })

        fireEvent.click(screen.getByRole('checkbox', { name: /Codex/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Save config and reload' }))

        await waitFor(() => expect(onSaveConfig).toHaveBeenCalledWith({ agentNames: ['Codex'] }))
    })

    it('can draft config changes without rendering per-form save buttons', () => {
        const onConfigChange = vi.fn()
        const view = renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'draft',
                    title: 'Draft',
                    components: [{
                        kind: 'schemaForm',
                        id: 'switches',
                        fields: [
                            { key: 'notifyReady', label: 'Ready', type: 'boolean', defaultValue: false }
                        ]
                    }]
                }]
            },
            onConfigChange
        })

        const scoped = within(view.container)
        expect(scoped.queryByRole('button', { name: 'Save config and reload' })).not.toBeInTheDocument()
        fireEvent.click(scoped.getByRole('checkbox', { name: 'Ready' }))
        expect(onConfigChange).toHaveBeenCalledWith({ notifyReady: true })
    })

    it('renders generic runner spawn defaults editor descriptors without plugin-id special casing', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'runner',
                    title: 'Runner',
                    components: [{
                        kind: 'runnerSpawnDefaultsEditor',
                        id: 'defaults',
                        configKey: 'rulesJson'
                    }]
                }]
            },
            machines: [],
            onConfigChange: vi.fn()
        })

        expect(screen.getByText('Runner spawn defaults')).toBeInTheDocument()
        expect(screen.getByText('No saved presets yet; the first preset draft is expanded below. Set any default and save/reload from the top-right to apply.')).toBeInTheDocument()
    })
})
