import { describe, expect, test } from 'bun:test'
import {
    AgentConfigDescriptorSchema,
    getAgentConfigDescriptor,
    getBuiltinAgentConfigDescriptors
} from './agentConfig'

describe('agent config descriptors', () => {
    test('exposes model-dependent Antigravity effort at creation and during a session', () => {
        expect(getAgentConfigDescriptor('agy').fields).toContainEqual({
            id: 'effort', section: 'effort', kind: 'select', optionSource: 'model', availability: 'both'
        })
    })
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

    test('reports DSH permission as managed by its ACP composition', () => {
        const descriptor = getAgentConfigDescriptor('dsh')
        expect(descriptor.fields).toEqual([expect.objectContaining({
            id: 'permission',
            kind: 'status',
            availability: 'managed'
        })])
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

    test('every builtin descriptor validates', () => {
        const descriptors = getBuiltinAgentConfigDescriptors()
        expect(descriptors.length).toBeGreaterThan(0)
        for (const descriptor of descriptors) {
            expect(AgentConfigDescriptorSchema.safeParse(descriptor).success).toBe(true)
        }
    })
})

test('runner capabilities carry descriptors for every built-in agent', async () => {
    const { RUNNER_CAPABILITIES } = await import('./runnerCapabilities')
    expect(RUNNER_CAPABILITIES.agentConfigs.map((descriptor) => descriptor.flavor)).toContain('cursor')
})
