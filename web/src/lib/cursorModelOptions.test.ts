import { describe, expect, it } from 'vitest'
import {
    buildCursorEffortPickerOptions,
    buildCursorModelCatalog,
    buildFlatCursorModelPickerOptions,
    cursorCatalogHasMultiVariantBases,
    shouldUseCursorDualPickers,
    cursorEffortPickerLabel,
    cursorModelBaseId,
    cursorModelDedupeKey,
    cursorModelVariantId,
    cursorVariantDisambiguationSuffix,
    cursorVariantLabel,
    cursorVaryingWireParamKeys,
    formatCursorModelPickerLabel,
    parseCursorWireParams,
    resolveCursorBaseKey,
    resolveCursorVariantOptions
} from './cursorModelOptions'

const acpModels = [
    { modelId: 'default[]', name: 'Auto' },
    { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
    { modelId: 'composer-2.5[fast=false]', name: 'Composer 2.5' },
    { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]', name: 'Claude Opus 4.8' },
    { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=low,fast=false]', name: 'Claude Opus 4.8' },
] as const

describe('raw Cursor ACP model splitting', () => {
    it('splits wire ids into raw base and variant parts', () => {
        expect(cursorModelBaseId('composer-2.5[fast=true]')).toBe('composer-2.5')
        expect(cursorModelDedupeKey('composer-2.5-fast')).toBe('composer-2.5-fast')
        expect(cursorModelVariantId('composer-2.5[fast=true]')).toBe('fast=true')
        expect(cursorVariantLabel('claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]')).toBe(
            'thinking=true,context=300k,effort=high,fast=false'
        )
    })

    it('parses raw comma-separated wire parameters without changing labels', () => {
        expect(
            parseCursorWireParams('claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]')
        ).toEqual({
            thinking: 'true',
            context: '300k',
            effort: 'high',
            fast: 'false',
        })
        expect(cursorVaryingWireParamKeys([
            'composer-2.5[fast=true]',
            'composer-2.5[fast=false]',
        ])).toEqual(['fast'])
    })
})

describe('buildCursorModelCatalog', () => {
    it('groups exact ACP wire variants by raw base id and sorts model bases', () => {
        const catalog = buildCursorModelCatalog([...acpModels])
        expect(catalog.baseOptions.map((o) => o.label)).toEqual([
            'Default',
            'claude-opus-4-8',
            'composer-2.5',
        ])
        expect(resolveCursorVariantOptions('composer-2.5', catalog).map((v) => v.label)).toEqual([
            'fast=true',
            'fast=false',
        ])
    })

    it('does not merge legacy sku aliases into ACP bases', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
        ])
        expect(catalog.baseOptions.map((o) => o.value)).toEqual([
            null,
            'composer-2.5',
            'composer-2.5-fast',
        ])
    })

    it('resolves current wire to base and variant list', () => {
        const catalog = buildCursorModelCatalog([...acpModels], {
            currentModel: 'composer-2.5[fast=true]',
        })
        expect(resolveCursorBaseKey('composer-2.5[fast=true]', catalog)).toBe('composer-2.5')
        expect(resolveCursorVariantOptions('composer-2.5', catalog)).toHaveLength(2)
    })

    it('ignores Cursor-provided display names for picker labels', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'gpt-5.3-codex[reasoning=medium,fast=false]', name: 'Codex 5.3' },
        ], { defaultValue: 'auto' })
        expect(catalog.baseOptions.find((entry) => entry.value === 'gpt-5.3-codex')?.label).toBe('gpt-5.3-codex')
    })
})

describe('picker labels and modes', () => {
    it('formats flat labels as raw base when a base has one variant', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]', name: 'Claude Opus 4.7' },
            { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
        ], { defaultValue: 'auto' })
        expect(cursorCatalogHasMultiVariantBases(catalog)).toBe(false)
        expect(buildFlatCursorModelPickerOptions(catalog, { defaultValue: 'auto' })).toEqual([
            { value: 'auto', label: 'Default' },
            {
                value: 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]',
                label: 'claude-opus-4-7 · thinking=true,context=300k,effort=xhigh,fast=false'
            },
            { value: 'composer-2.5[fast=true]', label: 'composer-2.5 · fast=true' }
        ])
    })

    it('lists a single variant row when a base has one wire', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
        ], { defaultValue: 'auto' })
        expect(buildCursorEffortPickerOptions(resolveCursorVariantOptions('gpt-5.5', catalog))).toEqual([
            {
                value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
                label: 'context=272k,reasoning=medium,fast=false'
            }
        ])
    })

    it('shows raw variant labels when a base has multiple variants', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
            { modelId: 'composer-2.5[fast=false]', name: 'Composer 2.5' },
        ], { defaultValue: 'auto' })
        expect(buildFlatCursorModelPickerOptions(catalog, { defaultValue: 'auto' })).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'composer-2.5[fast=true]', label: 'fast=true' },
            { value: 'composer-2.5[fast=false]', label: 'fast=false' },
        ])
        expect(buildCursorEffortPickerOptions(resolveCursorVariantOptions('composer-2.5', catalog))).toEqual([
            { value: 'composer-2.5[fast=true]', label: 'fast=true' },
            { value: 'composer-2.5[fast=false]', label: 'fast=false' },
        ])
    })

    it('enables dual pickers when a base has multiple exact wire ids', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]', name: 'Claude Opus 4.7' },
            { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
            { modelId: 'composer-2.5[fast=false]', name: 'Composer 2.5' },
        ], { defaultValue: 'auto' })
        expect(cursorCatalogHasMultiVariantBases(catalog)).toBe(true)
        expect(shouldUseCursorDualPickers(catalog, 'composer-2.5[fast=false]')).toBe(true)
    })

    it('uses raw variant suffixes for compatibility helpers', () => {
        expect(cursorEffortPickerLabel('claude-opus-4-8[effort=high,fast=false]', [])).toBe('effort=high,fast=false')
        expect(cursorVariantDisambiguationSuffix('claude-opus-4-8[effort=high,fast=false]')).toBe('effort=high,fast=false')
        expect(formatCursorModelPickerLabel('composer-2.5[fast=true]', 'ignored')).toBe('composer-2.5 · fast=true')
    })
})
