import { describe, expect, it } from 'vitest'
import {
    buildNewSessionCursorEffortOptions,
    buildNewSessionCursorModelCatalog,
    buildNewSessionCursorModelOptions,
    buildNewSessionCursorPickerState,
    isCursorEffortWireAllowed,
    pickCursorModelsForPicker,
    resolveNewSessionCursorBaseSelectValue,
    resolveNewSessionCursorEffortSelectValue,
    resolveWireIdForBaseChange,
    shouldShowCursorModelsUnavailable,
    shouldShowNewSessionCursorVariantPicker
} from './newSessionCursorModels'

const acpModels = [
    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
    { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' },
] as const

describe('shouldShowCursorModelsUnavailable', () => {
    it('shows hint when cursor agent has no ACP wire models and is not loading', () => {
        expect(shouldShowCursorModelsUnavailable({
            agent: 'cursor',
            isLoading: false,
            error: null,
            availableModels: []
        })).toBe(true)
        expect(shouldShowCursorModelsUnavailable({
            agent: 'cursor',
            isLoading: false,
            error: null,
            availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }]
        })).toBe(true)
    })

    it('hides hint while loading or on error', () => {
        expect(shouldShowCursorModelsUnavailable({
            agent: 'cursor',
            isLoading: true,
            error: null,
            availableModels: []
        })).toBe(false)
        expect(shouldShowCursorModelsUnavailable({
            agent: 'cursor',
            isLoading: false,
            error: 'boom',
            availableModels: []
        })).toBe(false)
    })

    it('hides hint for non-cursor agents', () => {
        expect(shouldShowCursorModelsUnavailable({
            agent: 'claude',
            isLoading: false,
            error: null,
            availableModels: []
        })).toBe(false)
    })
})

describe('pickCursorModelsForPicker', () => {
    it('prefers ACP wire ids when both ACP and CLI skus are present', () => {
        const mixed = [
            { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
        ]
        expect(pickCursorModelsForPicker(mixed)).toEqual([
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
        ])
    })
})

describe('shouldShowNewSessionCursorVariantPicker', () => {
    it('shows variant picker only when a base has multiple exact wire ids', () => {
        const picker = buildNewSessionCursorPickerState([...acpModels], 'composer-2.5[fast=true]')
        expect(shouldShowNewSessionCursorVariantPicker(picker)).toBe(true)
    })

    it('uses flat picker when a base has only one wire id', () => {
        const wire = 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]'
        const picker = buildNewSessionCursorPickerState([
            { modelId: wire, name: 'Claude Opus 4.7' },
        ], wire)
        expect(picker.mode).toBe('flat')
        expect(shouldShowNewSessionCursorVariantPicker(picker)).toBe(false)
        expect(picker.modelOptions.some((row) => row.value === wire)).toBe(true)
    })
})

describe('flat vs dual cursor model pickers', () => {
    it('uses flat wire rows when each base has only one variant', () => {
        const picker = buildNewSessionCursorPickerState([
            { modelId: 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]', name: 'Claude Opus 4.7' },
            { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
        ], 'auto')
        const options = buildNewSessionCursorModelOptions(picker)
        expect(picker.mode).toBe('flat')
        expect(options).toEqual([
            { value: 'auto', label: 'Default' },
            {
                value: 'claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]',
                label: 'claude-opus-4-7 · thinking=true,context=300k,effort=xhigh,fast=false'
            },
            { value: 'composer-2.5[fast=true]', label: 'composer-2.5 · fast=true' },
        ])
    })

    it('uses dual pickers when one base has multiple wire ids', () => {
        const picker = buildNewSessionCursorPickerState([...acpModels], 'auto')
        expect(picker.mode).toBe('dual')
        expect(buildNewSessionCursorModelOptions(picker)).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'composer-2.5', label: 'composer-2.5' },
        ])
    })
})

describe('new session cursor select values', () => {
    it('uses explicit base state in dual mode instead of derived baseKey', () => {
        const picker = buildNewSessionCursorPickerState([...acpModels], 'composer-2.5[fast=true]')
        expect(resolveNewSessionCursorBaseSelectValue(picker, 'composer-2.5')).toBe('composer-2.5')
        expect(resolveNewSessionCursorBaseSelectValue(picker, 'auto')).toBe('auto')
    })

    it('keeps variant select value on exact wire id after catalog reload', () => {
        const picker = buildNewSessionCursorPickerState([...acpModels], 'composer-2.5[fast=false]')
        expect(
            resolveNewSessionCursorEffortSelectValue('composer-2.5[fast=false]', picker.effortOptions)
        ).toBe('composer-2.5[fast=false]')
    })

    it('returns auto when no exact variant is selected', () => {
        const picker = buildNewSessionCursorPickerState([...acpModels], 'auto')
        expect(resolveNewSessionCursorEffortSelectValue('auto', picker.effortOptions)).toBe('auto')
    })

    it('rejects variant wire ids outside the selected base', () => {
        const catalog = buildNewSessionCursorModelCatalog([...acpModels], 'composer-2.5[fast=true]')
        expect(
            isCursorEffortWireAllowed('composer-2.5[fast=false]', catalog, 'composer-2.5')
        ).toBe(true)
        expect(
            isCursorEffortWireAllowed('claude-opus-4-8[effort=high]', catalog, 'composer-2.5')
        ).toBe(false)
    })
})

describe('probe slug catalog (New Session cold start)', () => {
    it('does not inject CLI slug current model when machine list has no wire ids', () => {
        const probeOnly = [
            { modelId: 'composer-2.5', name: 'Composer 2.5' },
            { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
        ]
        const picker = buildNewSessionCursorPickerState(probeOnly, 'composer-2.5')
        expect(picker.mode).toBe('flat')
        expect(picker.modelOptions).toEqual([{ value: 'auto', label: 'Default' }])
        expect(picker.effortOptions).toEqual([])
        expect(shouldShowCursorModelsUnavailable({
            agent: 'cursor',
            isLoading: false,
            error: null,
            availableModels: [...probeOnly]
        })).toBe(true)
    })
})

describe('new session cursor model options', () => {
    it('maps base options with auto default and raw variant labels', () => {
        const picker = buildNewSessionCursorPickerState([...acpModels], 'composer-2.5[fast=true]')
        expect(buildNewSessionCursorModelOptions(picker)).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'composer-2.5', label: 'composer-2.5' },
        ])
        expect(buildNewSessionCursorEffortOptions(picker)).toEqual([
            { value: 'composer-2.5[fast=true]', label: 'fast=true' },
            { value: 'composer-2.5[fast=false]', label: 'fast=false' },
        ])
    })

    it('does not guess a wire when base has multiple variants', () => {
        const catalog = buildNewSessionCursorModelCatalog([...acpModels], 'auto')
        expect(resolveWireIdForBaseChange('composer-2.5', catalog)).toBeNull()
    })

    it('returns the sole wire when base has one variant', () => {
        const catalog = buildNewSessionCursorModelCatalog([
            { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]' }
        ], 'auto')
        expect(resolveWireIdForBaseChange('gpt-5.5', catalog)).toBe('gpt-5.5[context=272k,reasoning=medium,fast=false]')
    })

    it('returns auto wire id when base is reset to default', () => {
        const catalog = buildNewSessionCursorModelCatalog([...acpModels], 'auto')
        expect(resolveWireIdForBaseChange('auto', catalog)).toBe('auto')
        expect(buildNewSessionCursorEffortOptions(
            buildNewSessionCursorPickerState([...acpModels], 'auto')
        )).toEqual([])
    })

    it('labels context variants with raw suffixes', () => {
        const picker = buildNewSessionCursorPickerState([
            { modelId: 'claude-opus-4-8[context=200k]', name: 'Claude Opus 4.8' },
            { modelId: 'claude-opus-4-8[context=300k]', name: 'Claude Opus 4.8' },
        ], 'claude-opus-4-8[context=200k]')
        expect(buildNewSessionCursorEffortOptions(picker).map((entry) => entry.label)).toEqual([
            'context=200k',
            'context=300k'
        ])
    })
})
