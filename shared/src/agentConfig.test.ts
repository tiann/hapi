import { describe, expect, test } from 'bun:test'
import {
    AgentConfigDescriptorSchema,
    getAgentConfigDescriptor,
    getBuiltinAgentConfigDescriptors,
    resolveHapiYoloPermissionMode
} from './agentConfig'

describe('agent config descriptors', () => {
    test('exposes the three primary fields with their intended placements', () => {
        const descriptor = getAgentConfigDescriptor('codex')
        expect(descriptor.fields.map((field) => [field.id, field.section])).toEqual([
            ['model', 'model'],
            ['effort', 'effort'],
            ['permission', 'permission'],
            ['serviceTier', 'settings'],
            ['collaborationMode', 'settings']
        ])
    })

    test('models Cursor variant as a dependent model field rather than a page-specific control', () => {
        const descriptor = getAgentConfigDescriptor('cursor')
        expect(descriptor.fields).toContainEqual(expect.objectContaining({
            id: 'model',
            kind: 'dependent-select',
            optionSource: 'machine'
        }))
    })

    test('reports Pi permission as managed rather than pretending YOLO applies', () => {
        const descriptor = getAgentConfigDescriptor('pi')
        expect(descriptor.fields).toContainEqual(expect.objectContaining({
            id: 'permission',
            kind: 'status',
            availability: 'managed'
        }))
        expect(descriptor.fields).toContainEqual(expect.objectContaining({
            id: 'model',
            kind: 'grouped-select',
            optionSource: 'machine',
            availability: 'both'
        }))
        expect(descriptor.fields).toContainEqual(expect.objectContaining({
            id: 'effort',
            optionSource: 'static',
            availability: 'both'
        }))
        expect(resolveHapiYoloPermissionMode('pi')).toBeNull()
    })

    test('maps HAPI YOLO to each supported agent native permission mode', () => {
        expect(resolveHapiYoloPermissionMode('claude')).toBe('bypassPermissions')
        expect(resolveHapiYoloPermissionMode('grok')).toBe('bypassPermissions')
        expect(resolveHapiYoloPermissionMode('codex')).toBe('yolo')
        expect(resolveHapiYoloPermissionMode('cursor')).toBe('yolo')
        expect(resolveHapiYoloPermissionMode('opencode')).toBe('yolo')
        expect(resolveHapiYoloPermissionMode('kimi')).toBe('yolo')
    })

    test('validates descriptors received from a runner', () => {
        expect(AgentConfigDescriptorSchema.safeParse({
            flavor: 'example-agent',
            fields: [{
                id: 'model',
                section: 'model',
                kind: 'grouped-select',
                optionSource: 'directory',
                availability: 'both'
            }]
        }).success).toBe(true)
    })

    test('every builtin descriptor validates and carries a permission field', () => {
        const descriptors = getBuiltinAgentConfigDescriptors()
        expect(descriptors.length).toBeGreaterThan(0)
        for (const descriptor of descriptors) {
            expect(AgentConfigDescriptorSchema.safeParse(descriptor).success).toBe(true)
            expect(descriptor.fields.some((field) => field.id === 'permission')).toBe(true)
        }
    })
})

test('runner capabilities carry descriptors for every built-in agent', async () => {
    const { RUNNER_CAPABILITIES } = await import('./runnerCapabilities')
    expect(RUNNER_CAPABILITIES.agentConfigs.map((descriptor) => descriptor.flavor)).toContain('cursor')
})
