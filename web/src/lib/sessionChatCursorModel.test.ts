import { describe, expect, it } from 'vitest'
import {
    buildSessionCursorPickerState,
    isCursorEffortWireInCatalog,
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

    it('updates selected base without applying when the base has multiple variants', () => {
        const plan = resolveSessionCursorModelChange({
            picker,
            sessionModel: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            kind: 'base',
            value: 'composer-2.5'
        })
        expect(plan).toEqual({
            ok: true,
            wireId: null,
            nextSelectedBase: 'composer-2.5',
            shouldApply: false
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
