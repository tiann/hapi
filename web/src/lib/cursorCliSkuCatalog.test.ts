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

    it('groups legacy cursor-prefixed skus under their ACP base (#1818)', () => {
        const bareWires = [
            { modelId: 'grok-4.6', name: 'Cursor Grok 4.6' },
            { modelId: 'composer-2.5', name: 'Composer 2.5' },
        ]
        const catalog = appendCliSkusToCatalog(buildCursorModelCatalog(bareWires), [
            { modelId: 'cursor-grok-4.6-high', name: 'Cursor Grok 4.6' },
            { modelId: 'cursor-grok-4.6-high-fast', name: 'Cursor Grok 4.6 Fast' },
            { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
        ])

        const grokVariants = catalog.variantsByBase.get('grok-4.6') ?? []
        expect(grokVariants.map((row) => row.wireId)).toContain('cursor-grok-4.6-high')
        expect(grokVariants.map((row) => row.wireId)).toContain('cursor-grok-4.6-high-fast')
        expect(catalog.wireToBase.get('cursor-grok-4.6-high')).toBe('grok-4.6')
        // The unrelated prefix group must not absorb other bases' skus.
        expect(catalog.variantsByBase.get('composer-2.5')?.map((row) => row.wireId)).toEqual([
            'composer-2.5',
            'composer-2.5-fast'
        ])
    })
})
