import { describe, expect, it } from 'vitest'
import { appendCliSkusToCatalog, buildCursorModelCatalog } from '@/lib/cursorModelOptions'
import { buildCursorPickerState } from '@/lib/cursorPickerState'

describe('CLI sku variant catalog', () => {
    const wires = [
        { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' },
        { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
    ]
    const cliSkus = [
        { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
        { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' },
        { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
        { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
        { modelId: 'composer-2.5', name: 'Composer 2.5' },
    ]

    it('adds multiple CLI skus under the same ACP base', () => {
        const catalog = appendCliSkusToCatalog(buildCursorModelCatalog(wires), cliSkus)
        const gptVariants = catalog.variantsByBase.get('gpt-5.5') ?? []
        expect(gptVariants.length).toBeGreaterThan(3)
        expect(gptVariants.some((row) => row.wireId === 'gpt-5.5-high-fast')).toBe(true)
        expect(gptVariants.some((row) => row.wireId === 'gpt-5.5[context=272k,reasoning=medium,fast=false]')).toBe(true)
    })

    it('enables dual picker with multi sku variants for gpt-5.5', () => {
        const catalog = appendCliSkusToCatalog(buildCursorModelCatalog(wires), cliSkus)
        const picker = buildCursorPickerState({
            catalog,
            currentWireId: 'gpt-5.5-medium',
            defaultValue: 'auto'
        })
        expect(picker.mode).toBe('dual')
        const variantIds = picker.effortOptions.map((row) => row.value)
        expect(variantIds).toContain('gpt-5.5-high-fast')
        expect(variantIds).toContain('gpt-5.5-low')
        expect(variantIds.length).toBeGreaterThan(2)
    })
})
