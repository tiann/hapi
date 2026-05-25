import { createElement } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { builtinAgentDescriptors } from '@hapi/protocol/plugins'
import {
    RunnerSpawnDefaultsEditor,
    commonPermissionModesForAgents,
    parseRunnerSpawnDefaultConfig,
    resolveRunnerSpawnDefaultDrafts,
    serializeRunnerSpawnDefaultConfig,
    type RunnerSpawnDefaultDraft
} from './RunnerSpawnDefaultsEditor'

describe('RunnerSpawnDefaultsEditor helpers', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders an expanded editable draft when config is empty', () => {
        render(createElement(
            I18nProvider,
            null,
            createElement(RunnerSpawnDefaultsEditor, {
                config: {},
                machines: [],
                onConfigChange: vi.fn()
            })
        ))

        expect(screen.getByText('No saved presets yet; the first preset draft is expanded below. Set any default and save/reload from the top-right to apply.')).toBeInTheDocument()
        expect(screen.getByText('If')).toBeInTheDocument()
        expect(screen.getByText('Then default to')).toBeInTheDocument()
        expect(screen.getByText('Model')).toBeInTheDocument()
        expect(screen.getByText('Permission mode')).toBeInTheDocument()
    })

    it('uses the shared Claude effort presets in the visual editor', () => {
        render(createElement(
            I18nProvider,
            null,
            createElement(RunnerSpawnDefaultsEditor, {
                config: {
                    rulesJson: JSON.stringify([{
                        id: 'claude-default',
                        label: 'Claude default',
                        agentIds: ['claude'],
                        defaults: { effort: 'medium' }
                    }])
                },
                machines: [],
                onConfigChange: vi.fn()
            })
        ))

        const claudeEffort = screen.getByLabelText('Claude effort') as HTMLSelectElement
        const options = within(claudeEffort).getAllByRole('option').map((option) => ({
            value: (option as HTMLOptionElement).value,
            label: option.textContent
        }))
        expect(options).toEqual([
            { value: '', label: 'No default' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
        ])
        expect(options.some((option) => option.value === 'low')).toBe(false)
    })

    it('stores all-agent/all-workspace mode as empty scope instead of copying every option', () => {
        const presets: RunnerSpawnDefaultDraft[] = [{
            id: 'all-default',
            label: 'All default',
            enabled: true,
            agentMode: 'all',
            agentIds: ['codex', 'claude'],
            directoryMode: 'all',
            directoryPrefixes: ['/repo'],
            applyToResume: false,
            defaults: { permissionMode: 'default', model: 'gpt-5-codex' }
        }]

        const serialized = serializeRunnerSpawnDefaultConfig(presets)
        const rules = JSON.parse(String(serialized.rulesJson)) as Array<Record<string, unknown>>
        expect(rules[0]?.agentIds).toBeUndefined()
        expect(rules[0]?.directoryPrefixes).toBeUndefined()
        expect(rules[0]?.defaults).toEqual({ permissionMode: 'default', model: 'gpt-5-codex' })
    })

    it('migrates legacy flat config into a visual preset and serializes to rulesJson', () => {
        const parsed = parseRunnerSpawnDefaultConfig({
            agentIds: 'codex',
            directoryPrefixes: '/repo',
            permissionMode: 'yolo',
            modelReasoningEffort: 'xhigh'
        })
        expect(parsed.presets[0]).toMatchObject({
            agentMode: 'selected',
            agentIds: ['codex'],
            directoryMode: 'selected',
            directoryPrefixes: ['/repo'],
            defaults: { permissionMode: 'yolo', modelReasoningEffort: 'xhigh' }
        })

        const serialized = serializeRunnerSpawnDefaultConfig(parsed.presets, { agentIds: 'codex', permissionMode: 'yolo' })
        expect(serialized.agentIds).toBeUndefined()
        expect(serialized.permissionMode).toBeUndefined()
        expect(typeof serialized.rulesJson).toBe('string')
    })

    it('filters permission modes to the common modes for selected agents', () => {
        const descriptors = builtinAgentDescriptors()
        expect(commonPermissionModesForAgents(['codex', 'gemini'], descriptors, [])).toEqual(['default', 'read-only', 'safe-yolo', 'yolo'])
        expect(commonPermissionModesForAgents(['codex', 'claude'], descriptors, [])).toEqual(['default'])
    })

    it('resolves draft presets by specificity for test matching', () => {
        const presets: RunnerSpawnDefaultDraft[] = [
            {
                id: 'all',
                label: 'All',
                enabled: true,
                agentMode: 'all',
                agentIds: [],
                directoryMode: 'all',
                directoryPrefixes: [],
                applyToResume: false,
                defaults: { model: 'base', permissionMode: 'default' }
            },
            {
                id: 'codex-repo',
                label: 'Codex Repo',
                enabled: true,
                agentMode: 'selected',
                agentIds: ['codex'],
                directoryMode: 'selected',
                directoryPrefixes: ['/repo'],
                applyToResume: false,
                defaults: { model: 'gpt-5-codex', permissionMode: 'yolo' }
            }
        ]
        const result = resolveRunnerSpawnDefaultDrafts(presets, { agent: 'codex', directory: '/repo/app' })
        expect(result.matched.map((preset) => preset.id)).toEqual(['all', 'codex-repo'])
        expect(result.options).toEqual({ model: 'gpt-5-codex', permissionMode: 'yolo' })
    })
})
