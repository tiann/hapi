import { describe, expect, it } from 'vitest'
import { appendCliSkusToCatalog, buildCursorModelCatalog } from '@/lib/cursorModelOptions'
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
})
