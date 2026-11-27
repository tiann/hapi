import { describe, expect, it } from 'vitest'
import { appendCliSkusToCatalog, buildCursorModelCatalog } from '@/lib/cursorModelOptions'
import { mergeCursorCliModelSkus } from '@/lib/cursorPickerState'
import {
    buildSessionCursorPickerState,
    resolveSessionCursorVariantSelectValue
} from '@/lib/sessionChatCursorModel'

describe('in-session cursor catalog with CLI skus', () => {
    const sessionWires = [
        { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }
    ]
    const cliSkus = [
        { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
        { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' },
        { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' }
    ]

    it('builds dual picker with multiple gpt-5.5 variants inside a session', () => {
        const catalog = appendCliSkusToCatalog(buildCursorModelCatalog(sessionWires), cliSkus)
        const picker = buildSessionCursorPickerState({
            sessionModels: sessionWires,
            machineModels: [],
            cliModelSkus: cliSkus,
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })
        expect(picker.mode).toBe('dual')
        expect(picker.effortOptions.length).toBeGreaterThan(2)
        expect(catalog.variantsByBase.get('gpt-5.5')?.some((row) => row.wireId === 'gpt-5.5-high-fast')).toBe(true)
    })

    it('merges machine SKU catalog over partial session SKUs for friendly variant labels', () => {
        const machineWires = [
            { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
            { modelId: 'gpt-5.5[context=272k,reasoning=high,fast=false]', name: 'gpt-5.5' }
        ]
        const sessionSkus = [
            { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
            { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' }
        ]
        const machineSkus = [
            ...sessionSkus,
            { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
            { modelId: 'gpt-5.5-high', name: 'GPT-5.5 High' }
        ]
        const mergedSkus = mergeCursorCliModelSkus(machineSkus, sessionSkus)
        const picker = buildSessionCursorPickerState({
            sessionModels: sessionWires,
            machineModels: machineWires,
            cliModelSkus: mergedSkus,
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })

        expect(picker.mode).toBe('dual')
        expect(picker.effortOptions.length).toBeGreaterThan(2)
        expect(picker.effortOptions.every((row) => !row.label.includes('context=272k'))).toBe(true)
    })

    it('shows raw variant suffixes when dual catalog has wires but no CLI skus', () => {
        const picker = buildSessionCursorPickerState({
            sessionModels: [
                { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
                { modelId: 'gpt-5.5[context=272k,reasoning=high,fast=false]', name: 'gpt-5.5' }
            ],
            machineModels: [],
            cliModelSkus: [],
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })

        expect(picker.effortOptions.some((row) => row.label.includes('reasoning='))).toBe(true)
    })

    it('highlights the matching CLI sku when session stores the ACP wire id', () => {
        const picker = buildSessionCursorPickerState({
            sessionModels: sessionWires,
            machineModels: [],
            cliModelSkus: cliSkus,
            sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            sessionCurrentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })
        const selected = resolveSessionCursorVariantSelectValue(
            'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            picker.effortOptions
        )
        expect(selected).toBe('gpt-5.5-medium')
        expect(picker.effortOptions.every((row) => !row.label.includes('context=272k'))).toBe(true)
        expect(picker.effortOptions.some((row) => row.value === 'gpt-5.5-medium')).toBe(true)
    })
    it('does not highlight a nearby SKU when its speed or effort differs from the confirmed wire', () => {
        const options = ['gpt-5.5-fast', 'gpt-5.5-high-fast', 'gpt-5.5-medium'].map(value => ({ value }))
        expect(resolveSessionCursorVariantSelectValue('gpt-5.5[reasoning=high,fast=false]', options)).toBeNull()
        expect(resolveSessionCursorVariantSelectValue('gpt-5.5[reasoning=low,fast=true]', options)).toBeNull()
        expect(resolveSessionCursorVariantSelectValue('gpt-5.5[context=1m]', options)).toBeNull()
        expect(resolveSessionCursorVariantSelectValue('gpt-5.5[reasoning=high,fast=true]', options))
            .toBe('gpt-5.5-high-fast')
    })

    it('highlights the confirmed reasoning_effort on Grok and leaves an incomplete SKU catalog unselected', () => {
        const wire = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
        const partial = [{ value: 'grok-4.7-fast' }, { value: 'grok-4.7-low-fast' }]
        expect(resolveSessionCursorVariantSelectValue(wire, partial)).toBeNull()
        expect(resolveSessionCursorVariantSelectValue('grok-4.7[unknown_effort=high,fast=true]', partial)).toBeNull()
        const high = { value: 'grok-4.7-high-fast' }
        expect(resolveSessionCursorVariantSelectValue(wire, [...partial, high])).toBe(high.value)
    })

})
