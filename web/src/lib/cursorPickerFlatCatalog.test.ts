import { describe, expect, it } from 'vitest'
import { buildNewSessionCursorPickerState, shouldShowNewSessionCursorVariantPicker } from '@/components/NewSession/newSessionCursorModels'
import { buildCursorPickerState } from '@/lib/cursorPickerState'

/** Live ACP catalog shape: one wire id per base family (28 rows). */
const LIVE_ACP_SAMPLE = [
    'default[]',
    'composer-2.5[fast=true]',
    'gpt-5.5[context=272k,reasoning=medium,fast=false]',
    'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]',
    'gpt-5.3-codex[reasoning=medium,fast=false]',
] as const

describe('flat catalog (one wire per base)', () => {
    const models = LIVE_ACP_SAMPLE.map((modelId) => ({ modelId }))

    it('New Session uses flat picker without a useless variant dropdown', () => {
        const picker = buildNewSessionCursorPickerState(models, 'auto')
        expect(picker.mode).toBe('flat')
        expect(shouldShowNewSessionCursorVariantPicker(picker)).toBe(false)
        expect(picker.modelOptions.length).toBe(5)
        expect(picker.modelOptions.some((row) => row.value === 'gpt-5.5[context=272k,reasoning=medium,fast=false]')).toBe(true)
    })

    it('Session chat flat picker lists exact wire ids', () => {
        const picker = buildCursorPickerState({
            catalog: buildNewSessionCursorPickerState(models, 'auto').catalog,
            currentWireId: 'composer-2.5[fast=true]',
            defaultValue: null
        })
        expect(picker.mode).toBe('flat')
        expect(picker.showEffortPicker).toBe(false)
        expect(picker.modelOptions.find((row) => row.value === 'composer-2.5[fast=true]')).toBeDefined()
    })
})

describe('dual catalog (multiple wires per base)', () => {
    const models = [
        { modelId: 'composer-2.5[fast=true]' },
        { modelId: 'composer-2.5[fast=false]' },
    ]

    it('shows variant picker only when a base has 2+ wire ids', () => {
        const picker = buildNewSessionCursorPickerState(models, 'composer-2.5[fast=true]')
        expect(picker.mode).toBe('dual')
        expect(shouldShowNewSessionCursorVariantPicker(picker)).toBe(true)
        expect(picker.effortOptions).toHaveLength(2)
    })
})
