import { describe, expect, it } from 'vitest'
import {
    buildSessionCursorPickerState,
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
    it.each([false, true])('keeps Auto label without a restart warning (native=%s)', (nativeAuto) => {
        const picker = buildSessionCursorPickerState({
            sessionModels: [{ modelId: nativeAuto ? 'auto' : 'default' }, ...sessionModels],
            machineModels: [{ modelId: 'auto' }],
            sessionModel: 'composer-2.5[fast=true]',
            sessionCurrentModelId: 'composer-2.5[fast=true]'
        })
        expect(picker.modelOptions.find(option => option.value === 'auto')?.label)
            .toBe('Auto')
    })

    it('still supports an optional Auto restart label for callers that need it', () => {
        const picker = buildSessionCursorPickerState({
            sessionModels: [{ modelId: 'default' }, ...sessionModels],
            machineModels: [{ modelId: 'auto' }],
            sessionModel: 'composer-2.5[fast=true]',
            sessionCurrentModelId: 'composer-2.5[fast=true]',
            autoRestartLabel: 'Auto (switching back requires restart)'
        })
        expect(picker.modelOptions.find(option => option.value === 'auto')?.label)
            .toBe('Auto (switching back requires restart)')
    })

    const picker = buildSessionCursorPickerState({
        sessionModels,
        machineModels: [],
        sessionModel: 'composer-2.5[fast=true]',
        sessionCurrentModelId: 'composer-2.5[fast=true]'
    })

    it('keeps the current variant when reselecting a model or its selected parameter', () => {
        expect(resolveSessionCursorModelChange(picker, 'model', 'composer-2.5')).toBeNull()
        expect(resolveSessionCursorModelChange(picker, 'parameter', 'composer-2.5[fast=true]')).toBeNull()
    })

    it('uses a single advertised variant for an explicit model choice', () => {
        const fromAuto = buildSessionCursorPickerState({
            sessionModels, machineModels: [], sessionModel: 'auto', sessionCurrentModelId: null
        })
        expect(resolveSessionCursorModelChange(fromAuto, 'model', 'composer-2.5')).toBe('composer-2.5[fast=true]')
        expect(resolveSessionCursorBaseSelectValue(fromAuto)).toBe('auto')
    })

    it('rejects parameters from a different family even when they are still in the catalog', () => {
        const other = 'other[fast=false]'
        const multi = buildSessionCursorPickerState({
            sessionModels: [...sessionModels, { modelId: other }], machineModels: [],
            sessionModel: 'composer-2.5[fast=false]', sessionCurrentModelId: null
        })
        expect(resolveSessionCursorModelChange(multi, 'parameter', other)).toBeNull()
        expect(resolveSessionCursorModelChange(multi, 'model', 'other')).toBe(other)
        expect(resolveSessionCursorModelChange(multi, 'model', 'absent')).toBeNull()
    })

    it('accepts Auto and offered parameters but ignores stale selections', () => {
        expect(resolveSessionCursorModelChange(picker, 'model', 'auto')).toBe('auto')
        expect(resolveSessionCursorModelChange(picker, 'parameter', 'composer-2.5[fast=false]')).toBe('composer-2.5[fast=false]')
        expect(resolveSessionCursorModelChange(picker, 'parameter', 'absent[fast=true]')).toBeNull()
    })

    it.each(['default', 'default[]'])('offers an Auto retry when the session explicitly reports %s', (model) => {
        for (const models of [sessionModels, [{ modelId: 'single-model' }]]) {
            const reported = buildSessionCursorPickerState({
                sessionModels: models, machineModels: [], sessionModel: model,
                sessionCurrentModelId: 'auto', accountDefaultLabel: 'Account default'
            })
            expect(resolveSessionCursorBaseSelectValue(reported)).toBe(model)
            expect(reported.modelOptions).toContainEqual({ value: model, label: 'Account default' })
            expect(resolveSessionCursorModelChange(reported, 'model', 'auto')).toBe('auto')
            expect(resolveSessionCursorModelChange(reported, 'model', model)).toBeNull()
        }
    })

    it.each([null, 'auto'])('keeps startup or pinned Auto when only the catalog reports a default alias (%s)', (model) => {
        const auto = buildSessionCursorPickerState({
            sessionModels, machineModels: [], sessionModel: model, sessionCurrentModelId: 'default[]'
        })
        expect(resolveSessionCursorBaseSelectValue(auto)).toBe('auto')
        expect(auto.modelOptions.some(option => option.value === 'default[]')).toBe(false)
        expect(resolveSessionCursorModelChange(auto, 'model', 'auto')).toBeNull()
    })

    it('highlights Default when session has no model even if local base is auto', () => {
        const defaultPicker = buildSessionCursorPickerState({
            sessionModels,
            machineModels: [],
            sessionModel: null,
            sessionCurrentModelId: null
        })
        expect(resolveSessionCursorBaseSelectValue(defaultPicker)).toBe('auto')
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
        expect(resolveSessionCursorBaseSelectValue(flatPicker)).toBe('auto')
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
        expect(resolveSessionCursorBaseSelectValue(flatPicker))
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
        expect(resolveSessionCursorBaseSelectValue(flatPicker)).toBe('composer-2.5')
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
        expect(resolveSessionCursorModelChange(picker, 'parameter', 'gpt-5.5-high-fast')).toBe('gpt-5.5-high-fast')
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
