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

    it('clicking a base key in dual-style handler still resolves the sole wire for that base', () => {
        const picker = buildCursorPickerState({
            catalog: buildCursorCatalogFromSources({ sessionModels: liveModels, defaultValue: null }),
            currentWireId: 'composer-2.5[fast=true]',
            defaultValue: null
        })
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            kind: 'base',
            value: 'gpt-5.5'
        })
        expect(plan).toEqual({
            ok: true,
            wireId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            nextSelectedBase: 'gpt-5.5',
            shouldApply: true
        })
    })

    it('flat wire selection applies the exact wire id', () => {
        const picker = buildCursorPickerState({
            catalog: buildCursorCatalogFromSources({ sessionModels: liveModels, defaultValue: null }),
            currentWireId: 'composer-2.5[fast=true]',
            defaultValue: null
        })
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'auto',
            kind: 'flat',
            value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })
        expect(plan).toMatchObject({
            ok: true,
            wireId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            shouldApply: true
        })
    })

    it('highlights session base in dual mode while local base state is still auto', () => {
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
        expect(resolveSessionCursorBaseSelectValue(picker, 'auto')).toBe('composer-2.5')
    })
})
