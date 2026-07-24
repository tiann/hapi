import { describe, expect, it } from 'vitest'
import {
    buildCursorCatalogFromSources,
    buildCursorPickerState,
    mergeCursorModelSummaries,
    resolveWireIdForBaseChange
} from '@/lib/cursorPickerState'

describe('mergeCursorModelSummaries', () => {
    it('keeps session wire rows first and ignores duplicate machine rows', () => {
        const merged = mergeCursorModelSummaries(
            [{ modelId: 'composer-2.5[fast=false]', name: 'Composer 2.5' }],
            [
                { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
                { modelId: 'composer-2.5[fast=false]', name: 'raw-id' }
            ]
        )
        expect(merged.map((entry) => entry.modelId)).toEqual([
            'composer-2.5[fast=false]',
            'composer-2.5[fast=true]',
        ])
        const slow = merged.find((entry) => entry.modelId === 'composer-2.5[fast=false]')
        expect(slow?.name).toBe('Composer 2.5')
    })

    it('injects current wire when missing from both lists', () => {
        const merged = mergeCursorModelSummaries([], [], 'claude-opus-4-8[effort=high,fast=false]')
        expect(merged).toEqual([
            { modelId: 'claude-opus-4-8[effort=high,fast=false]' }
        ])
    })

    it('drops CLI effort/speed SKU slugs but keeps bare ACP bases', () => {
        const merged = mergeCursorModelSummaries(
            [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            [
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'composer-2.5', name: 'Composer 2.5' }
            ]
        )
        expect(merged.map((entry) => entry.modelId)).toEqual([
            'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            'composer-2.5'
        ])
    })
})

describe('buildCursorPickerState', () => {
    const dualModels = [
        { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
        { modelId: 'composer-2.5[fast=false]', name: 'Composer 2.5' }
    ] as const

    it('uses dual mode with raw variant labels for current base', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: dualModels,
            machineModels: [],
            currentWireId: 'composer-2.5[fast=false]',
            defaultValue: 'auto'
        })
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'composer-2.5[fast=false]',
            defaultValue: 'auto'
        })
        expect(picker.mode).toBe('dual')
        expect(picker.showEffortPicker).toBe(true)
        expect(picker.effortOptions.map((row) => row.label)).toEqual(['fast=true', 'fast=false'])
    })

    it('uses flat mode when each base has only one ACP wire', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: [
                { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
            ],
            defaultValue: null
        })
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            defaultValue: null
        })
        expect(picker.mode).toBe('flat')
        expect(picker.showEffortPicker).toBe(false)
        expect(picker.effortOptions).toEqual([])
        expect(picker.modelOptions).toHaveLength(3)
        expect(picker.modelOptions.map((row) => row.value).sort()).toEqual([
            'auto',
            'composer-2.5[fast=true]',
            'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        ].sort())
    })

    it('shows variant picker for current base when only that base has variants', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: [
                { modelId: 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]', name: 'Claude Opus 4.7' },
                ...dualModels
            ],
            defaultValue: null
        })
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'composer-2.5[fast=true]',
            defaultValue: null
        })
        expect(picker.showEffortPicker).toBe(true)
        expect(picker.baseKey).toBe('composer-2.5')
    })
})

describe('live bare ACP catalog (#1129)', () => {
    /** Live Cursor ACP shape (2026-07-22): bare bases, no brackets, empty cliModelSkus. */
    const LIVE_BARE_ACP_IDS = [
        'composer-2',
        'composer-2.5',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.3-codex',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'gemini-3.1-pro',
        'gemini-3-flash',
        'grok-4-20',
        'kimi-k2.5',
        'o3',
        'o4-mini',
        'gpt-4.1',
        'gpt-4o',
        'claude-4-sonnet',
        'claude-4-opus',
        'claude-3.7-sonnet',
        'claude-3.5-sonnet',
        'claude-3.5-haiku',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'deepseek-r1',
        'deepseek-v3.1',
        'cheetah',
        'auto',
        'default',
        // Accidental CLI SKU leakage into availableModels must not become a top-level row.
        'composer-2.5-fast'
    ] as const

    it('builds a non-empty flat picker from live-shaped bare ACP ids', () => {
        expect(LIVE_BARE_ACP_IDS).toHaveLength(31)
        const sessionModels = LIVE_BARE_ACP_IDS.map((modelId) => ({ modelId }))
        const catalog = buildCursorCatalogFromSources({
            sessionModels,
            machineModels: [],
            cliModelSkus: [],
            currentWireId: 'default',
            defaultValue: null
        })
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'default',
            defaultValue: null
        })

        expect(catalog.variantsByBase.size).toBeGreaterThan(0)
        expect(picker.modelOptions.length).toBeGreaterThan(1)
        expect(picker.modelOptions.some((row) => row.value === 'composer-2.5')).toBe(true)
        expect(picker.modelOptions.some((row) => row.value === 'claude-opus-4-8')).toBe(true)
        // CLI effort/speed SKUs must not become top-level bases.
        expect(picker.modelOptions.some((row) => row.value === 'composer-2.5-fast')).toBe(false)
        // Default tokens stay out of the catalog rows (Default row is synthetic auto).
        expect(picker.modelOptions.some((row) => row.value === 'default')).toBe(false)
        expect(picker.modelOptions[0]).toEqual({ value: 'auto', label: 'Default' })
    })

    it('attaches CLI SKUs under bare ACP bases for dual/nested variant UX', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: [
                { modelId: 'composer-2.5' },
                { modelId: 'gpt-5.5' }
            ],
            cliModelSkus: [
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' }
            ],
            defaultValue: null
        })
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'composer-2.5',
            defaultValue: null
        })
        expect(picker.mode).toBe('dual')
        expect(picker.modelOptions.some((row) => row.value === 'composer-2.5')).toBe(true)
        expect(picker.showEffortPicker).toBe(true)
        expect(picker.effortOptions.some((row) => row.value === 'composer-2.5-fast')).toBe(true)
    })
})

describe('resolveWireIdForBaseChange', () => {
    it('does not guess when switching to a base with multiple variants', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: [
                { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]', name: 'Opus 4.8' },
                { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=low,fast=false]', name: 'Opus 4.8' },
                { modelId: 'claude-opus-4-7[thinking=true,context=300k,effort=high,fast=false]', name: 'Opus 4.7' },
                { modelId: 'claude-opus-4-7[thinking=true,context=300k,effort=low,fast=false]', name: 'Opus 4.7' }
            ]
        })
        expect(resolveWireIdForBaseChange(
            'claude-opus-4-7',
            catalog,
            'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]'
        )).toBeNull()
    })

    it('applies the only exact wire when a base has one variant', () => {
        const catalog = buildCursorCatalogFromSources({
            sessionModels: [
                { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
            ]
        })
        expect(resolveWireIdForBaseChange('composer-2.5', catalog)).toBe('composer-2.5[fast=true]')
        expect(resolveWireIdForBaseChange('auto', catalog)).toBe('auto')
    })
})
