import { CLAUDE_MODEL_PRESETS, getClaudeModelLabel } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { agentSupportsYolo, CLAUDE_EFFORT_OPTIONS, MODEL_OPTIONS } from './types'
import type { AgentDescriptor } from '@hapi/protocol/plugins'

describe('Claude model options', () => {
    it('derives options from shared Claude model presets', () => {
        expect(MODEL_OPTIONS.claude).toEqual([
            { value: 'auto', label: 'Default' },
            ...CLAUDE_MODEL_PRESETS.map((model) => ({
                value: model,
                label: getClaudeModelLabel(model) ?? model
            }))
        ])
    })

    it('exposes friendly labels for Claude model presets', () => {
        expect(CLAUDE_MODEL_PRESETS).toEqual(['sonnet', 'sonnet[1m]', 'opus', 'opus[1m]'])
        expect(getClaudeModelLabel('sonnet[1m]')).toBe('Sonnet 1M')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
    })
})

describe('Claude effort options', () => {
    it('matches supported effort presets in expected order', () => {
        expect(CLAUDE_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })
})

function descriptor(permissionModes: AgentDescriptor['capabilities']['permissionModes']): AgentDescriptor {
    return {
        id: 'vendor:agent',
        displayName: 'Vendor Agent',
        source: 'plugin',
        adapter: { runtime: 'runner', kind: 'custom-runner-plugin', contributionId: 'adapter' },
        capabilities: { permissionModes },
        available: true
    }
}

describe('NewSession agent capability helpers', () => {
    it('detects yolo-compatible agent descriptors', () => {
        expect(agentSupportsYolo(descriptor(['default', 'yolo']))).toBe(true)
        expect(agentSupportsYolo(descriptor(['default', 'bypassPermissions']))).toBe(true)
        expect(agentSupportsYolo(descriptor(['default']))).toBe(false)
        expect(agentSupportsYolo(null)).toBe(false)
    })
})
