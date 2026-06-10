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

    it('drops CLI probe slugs without bracket wire params', () => {
        const merged = mergeCursorModelSummaries(
            [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            [
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'composer-2.5', name: 'Composer 2.5' }
            ]
        )
        expect(merged.map((entry) => entry.modelId)).toEqual([
            'gpt-5.5[context=272k,reasoning=medium,fast=false]'
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
