import { describe, expect, it } from 'vitest'
import {
    buildSessionCursorPickerState,
    isCursorEffortWireInCatalog,
    isSessionCursorCatalogAwaitingSkus,
    isSessionCursorCatalogLoading,
    isSessionCursorCatalogPending,
    isSessionCursorCatalogPendingWithTimeout,
    resolveSessionCursorBaseSelectValue,
    resolveSessionCursorModelChange
} from '@/lib/sessionChatCursorModel'

const sessionModels = [
    { modelId: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
    { modelId: 'composer-2.5[fast=false]', name: 'Composer 2.5' }
] as const

describe('resolveSessionCursorModelChange', () => {
    const picker = buildSessionCursorPickerState({
        sessionModels,
        machineModels: [],
        sessionModel: 'composer-2.5[fast=true]',
        sessionCurrentModelId: 'composer-2.5[fast=true]'
    })

    it('applies the default variant and keeps base selected when the base has multiple variants', () => {
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            kind: 'base',
            value: 'composer-2.5'
        })
        expect(plan).toEqual({
            ok: true,
            wireId: 'composer-2.5[fast=true]',
            nextSelectedBase: 'composer-2.5',
            shouldApply: true
        })
    })

    it('applies a base change when the base has exactly one wire variant', () => {
        const singlePicker = buildSessionCursorPickerState({
            sessionModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]' }],
            machineModels: [],
            sessionModel: null,
            sessionCurrentModelId: null
        })
        const plan = resolveSessionCursorModelChange({
            picker: singlePicker,
            sessionModel: null,
            cursorSelectedBase: 'auto',
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

    it('accepts exact variant wire ids without matching stale session baseKey', () => {
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            kind: 'effort',
            value: 'composer-2.5[fast=false]'
        })
        expect(plan).toEqual({
            ok: true,
            wireId: 'composer-2.5[fast=false]',
            nextSelectedBase: 'composer-2.5',
            shouldApply: true
        })
    })

    it('rejects variant wire ids missing from catalog', () => {
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            kind: 'effort',
            value: 'claude-opus-4-8[effort=high]'
        })
        expect(plan).toEqual({ ok: false, reason: 'effort wire id not in catalog' })
    })

    it('uses explicit selected base for dual-mode model row highlight', () => {
        expect(
            resolveSessionCursorBaseSelectValue(picker, 'composer-2.5')
        ).toBe('composer-2.5')
        expect(
            resolveSessionCursorBaseSelectValue(picker, 'auto')
        ).toBe('composer-2.5')
    })

    it('highlights Default when session has no model even if local base is auto', () => {
        const defaultPicker = buildSessionCursorPickerState({
            sessionModels,
            machineModels: [],
            sessionModel: null,
            sessionCurrentModelId: null
        })
        expect(resolveSessionCursorBaseSelectValue(defaultPicker, 'auto')).toBe('auto')
    })

    // Cursor ACP without parameterizedModelPicker returns one wire per base = flat picker.
    // The picker row for 'Default' is value='auto', so the resolver must yield 'auto' when
    // session.model is null, otherwise HappyComposer's `selectedModelBase === option.value`
    // check fails for every row and the dropdown looks empty.
    it('highlights Default in flat-mode picker when session is on ACP default[]', () => {
        const flatPicker = buildSessionCursorPickerState({
            sessionModels: [
                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }
            ],
            machineModels: [],
            sessionModel: null,
            sessionCurrentModelId: null
        })
        expect(flatPicker.mode).toBe('flat')
        expect(resolveSessionCursorBaseSelectValue(flatPicker, 'auto')).toBe('auto')
    })

    it('highlights the active wire id in flat-mode picker when session has an explicit model', () => {
        const flatPicker = buildSessionCursorPickerState({
            sessionModels: [
                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }
            ],
            machineModels: [],
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })
        expect(flatPicker.mode).toBe('flat')
        expect(resolveSessionCursorBaseSelectValue(flatPicker, 'auto'))
            .toBe('gpt-5.5[context=272k,reasoning=medium,fast=false]')
    })

    it('highlights bare ACP bases in flat mode (#1129)', () => {
        const flatPicker = buildSessionCursorPickerState({
            sessionModels: [
                { modelId: 'composer-2.5', name: 'composer-2.5' },
                { modelId: 'gpt-5.5', name: 'gpt-5.5' }
            ],
            machineModels: [],
            sessionModel: 'composer-2.5',
            sessionCurrentModelId: 'composer-2.5'
        })
        expect(flatPicker.mode).toBe('flat')
        expect(flatPicker.modelOptions.some((row) => row.value === 'composer-2.5')).toBe(true)
        expect(resolveSessionCursorBaseSelectValue(flatPicker, 'auto')).toBe('composer-2.5')
    })
})

describe('CLI sku variants in session picker', () => {
    it('accepts CLI sku ids attached to an ACP base', () => {
        const picker = buildSessionCursorPickerState({
            sessionModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]' }],
            machineModels: [],
            cliModelSkus: [
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' }
            ],
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cursorSelectedBase: 'gpt-5.5',
            kind: 'effort',
            value: 'gpt-5.5-high-fast'
        })
        expect(plan).toMatchObject({
            ok: true,
            wireId: 'gpt-5.5-high-fast',
            shouldApply: true
        })
    })
})

describe('session cursor catalog readiness', () => {
    const dualPicker = buildSessionCursorPickerState({
        sessionModels: [
            { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
            { modelId: 'gpt-5.5[context=272k,reasoning=high,fast=false]', name: 'gpt-5.5' }
        ],
        machineModels: [],
        cliModelSkus: [],
        sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
        sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
    })

    it('waits for session and machine loading', () => {
        expect(isSessionCursorCatalogLoading({
            sessionLoading: true,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null
        })).toBe(true)
        expect(isSessionCursorCatalogLoading({
            sessionLoading: false,
            machineLoading: true,
            hasMachineId: true,
            sessionError: null,
            machineError: null
        })).toBe(true)
        expect(isSessionCursorCatalogLoading({
            sessionLoading: false,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null
        })).toBe(false)
    })

    it('does not wait for machine loading after machine error or without machine id', () => {
        expect(isSessionCursorCatalogLoading({
            sessionLoading: false,
            machineLoading: true,
            hasMachineId: true,
            sessionError: null,
            machineError: 'boom'
        })).toBe(false)
        expect(isSessionCursorCatalogLoading({
            sessionLoading: false,
            machineLoading: true,
            hasMachineId: false,
            sessionError: null,
            machineError: null
        })).toBe(false)
    })

    it('awaits SKUs for dual picker when merged catalog is still empty', () => {
        expect(isSessionCursorCatalogAwaitingSkus({
            sessionLoading: false,
            machineLoading: false,
            sessionError: null,
            machineError: null,
            mergedSkus: [],
            picker: dualPicker
        })).toBe(true)
        expect(isSessionCursorCatalogAwaitingSkus({
            sessionLoading: false,
            machineLoading: false,
            sessionError: null,
            machineError: null,
            mergedSkus: [{ modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' }],
            picker: dualPicker
        })).toBe(false)
    })

    it('combines loading and SKU awaiting into pending state', () => {
        expect(isSessionCursorCatalogPending({
            sessionLoading: false,
            machineLoading: true,
            hasMachineId: true,
            sessionError: null,
            machineError: null,
            mergedSkus: [],
            picker: dualPicker
        })).toBe(true)
        expect(isSessionCursorCatalogPending({
            sessionLoading: false,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null,
            mergedSkus: [],
            picker: dualPicker
        })).toBe(true)
        expect(isSessionCursorCatalogPending({
            sessionLoading: false,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null,
            mergedSkus: [{ modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' }],
            picker: dualPicker
        })).toBe(false)
    })

    it('does not await SKUs for flat picker sessions', () => {
        const flatPicker = buildSessionCursorPickerState({
            sessionModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            machineModels: [],
            cliModelSkus: [],
            sessionModel: 'composer-2.5[fast=true]',
            sessionCurrentModelId: 'composer-2.5[fast=true]'
        })

        expect(isSessionCursorCatalogPending({
            sessionLoading: false,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null,
            mergedSkus: [],
            picker: flatPicker
        })).toBe(false)
    })

    it('stays pending for loading even when SKU timeout has elapsed', () => {
        expect(isSessionCursorCatalogPendingWithTimeout({
            sessionLoading: true,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null,
            mergedSkus: [],
            picker: dualPicker,
            awaitingStartedAtMs: 0,
            nowMs: 20_000,
            timeoutMs: 15_000
        })).toBe(true)
    })

    it('degrades SKU awaiting after timeout while keeping loading pending', () => {
        const startedAt = 1_000
        const args = {
            sessionLoading: false,
            machineLoading: false,
            hasMachineId: true,
            sessionError: null,
            machineError: null,
            mergedSkus: [] as const,
            picker: dualPicker,
            awaitingStartedAtMs: startedAt,
            timeoutMs: 15_000
        }

        expect(isSessionCursorCatalogPendingWithTimeout({
            ...args,
            nowMs: startedAt + 5_000
        })).toBe(true)
        expect(isSessionCursorCatalogPendingWithTimeout({
            ...args,
            nowMs: startedAt + 15_000
        })).toBe(false)
    })
})

describe('isCursorEffortWireInCatalog', () => {
    it('checks wireToBase membership', () => {
        const picker = buildSessionCursorPickerState({
            sessionModels,
            machineModels: [],
            sessionModel: null,
            sessionCurrentModelId: null
        })
        expect(isCursorEffortWireInCatalog('composer-2.5[fast=false]', picker.catalog)).toBe(true)
        expect(isCursorEffortWireInCatalog('unknown[fast=true]', picker.catalog)).toBe(false)
    })
})
