import { describe, expect, it } from 'vitest'
import { getModelOptionsForFlavor } from '@/components/AssistantChat/modelOptions'
import {
    buildCursorCatalogFromSources,
    buildCursorPickerState
} from '@/lib/cursorPickerState'
import {
    resolveSessionCursorBaseSelectValue,
    resolveSessionCursorModelChange
} from '@/lib/sessionChatCursorModel'

const liveModels = [
    { modelId: 'default[]', name: 'Auto' },
    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
    { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
    { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]', name: 'claude-opus-4-8' }
] as const

describe('cursor picker UI simulation (no browser)', () => {
    it('flat model list shows one row per ACP wire with variant suffix in the label', () => {
        const wire = 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        const picker = buildCursorPickerState({
            catalog: buildCursorCatalogFromSources({ sessionModels: liveModels, defaultValue: null }),
            currentWireId: wire,
            defaultValue: null
        })
        expect(picker.mode).toBe('flat')
        const rendered = getModelOptionsForFlavor('cursor', wire, picker.modelOptions)
        expect(rendered).toHaveLength(4)
        expect(rendered.some((row) => row.value === wire)).toBe(true)
        expect(rendered.find((row) => row.value === wire)?.label).toContain('reasoning=medium')
    })

    it('resolves a family with one wire when another family makes the picker dual', () => {
        const picker = buildCursorPickerState({
            catalog: buildCursorCatalogFromSources({
                sessionModels: [...liveModels, { modelId: 'composer-2.5[fast=false]' }], defaultValue: null
            }),
            currentWireId: 'composer-2.5[fast=true]', defaultValue: null
        })
        expect(picker.mode).toBe('dual')
        expect(resolveSessionCursorModelChange(picker, 'model', 'gpt-5.5')).toBe(liveModels[2].modelId)
    })

    it('applies the exact wire ID in a flat picker', () => {
        const picker = buildCursorPickerState({
            catalog: buildCursorCatalogFromSources({ sessionModels: liveModels, defaultValue: null }),
            currentWireId: 'composer-2.5[fast=true]', defaultValue: null
        })
        expect(resolveSessionCursorModelChange(picker, 'model', liveModels[2].modelId)).toBe(liveModels[2].modelId)
    })

    it('highlights the confirmed session base in dual mode', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: [
                ...liveModels,
                { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
            ],
            defaultValue: null
        })
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'composer-2.5[fast=true]',
            defaultValue: null
        })
        expect(picker.mode).toBe('dual')
        expect(resolveSessionCursorBaseSelectValue(picker)).toBe('composer-2.5')
    })
})
