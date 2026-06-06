import { describe, expect, it } from 'vitest'
import { appendCliSkusToCatalog, buildCursorEffortPickerOptions, buildCursorModelCatalog, resolveCursorVariantOptions } from '@/lib/cursorModelOptions'

describe('resolveCursorVariantOptions with CLI skus', () => {
    it('omits raw ACP wire row when CLI skus exist for the same base', () => {
        const catalog = appendCliSkusToCatalog(
            buildCursorModelCatalog([
                { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }
            ]),
            [
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
            ]
        )
        const variants = resolveCursorVariantOptions('gpt-5.5', catalog)
        const options = buildCursorEffortPickerOptions(variants)
        expect(options.map((row) => row.value)).toEqual(['gpt-5.5-medium', 'gpt-5.5-high-fast'])
        expect(options[0]?.label).toBe('GPT-5.5 1M')
        expect(options.some((row) => row.label.includes('context=272k'))).toBe(false)
    })

    it('keeps ACP wire rows when no CLI skus are attached', () => {
        const catalog = buildCursorModelCatalog([
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
            { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
        ])
        expect(resolveCursorVariantOptions('composer-2.5', catalog)).toHaveLength(2)
    })
})
