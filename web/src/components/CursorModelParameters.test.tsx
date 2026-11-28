import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CursorModelParameters } from './CursorModelParameters'

function show(ids: string[], selected = ids[0], disabled = false) {
    const onChange = vi.fn()
    render(<I18nProvider><CursorModelParameters options={ids.map(value => ({ value, label: value }))}
        selectedValue={selected} disabled={disabled} onChange={onChange} /></I18nProvider>)
    return onChange
}

describe('Cursor model parameters', () => {
    it('preserves thinking and context while switching effort or speed using exact advertised wires', () => {
        const ids = ['a[effort=low,fast=false,thinking=true,context=64k]',
            'a[thinking=true,context=64k,fast=true,effort=low]',
            'a[effort=high,thinking=true,context=64k,fast=false]',
            'a[effort=high,fast=true,thinking=true,context=64k]']
        const onChange = show(ids)
        fireEvent.change(screen.getByRole('combobox', { name: 'Fast Mode' }), { target: { value: ids[1] } })
        fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: ids[2] } })
        expect(onChange.mock.calls).toEqual([[ids[1]], [ids[2]]])
        expect(screen.queryByRole('combobox', { name: 'Context window' })).toBeNull()
    })

    it('exposes the Grok reasoning_effort axis separately from speed on the live catalog format', () => {
        const ids = ['grok-4.7[context=256k,reasoning_effort=high,fast=true]',
            'grok-4.7[context=256k,reasoning_effort=high,fast=false]',
            'grok-4.7[context=256k,reasoning_effort=low,fast=true]']
        const onChange = show(ids)
        fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning effort' }), { target: { value: ids[2] } })
        fireEvent.change(screen.getByRole('combobox', { name: 'Fast Mode' }), { target: { value: ids[1] } })
        expect(onChange.mock.calls).toEqual([[ids[2]], [ids[1]]])
    })

    it('offers independently reachable settings on sparse CLI SKU grids', () => {
        const ids = ['a-medium', 'a-high', 'a-high-fast']
        const onChange = show(ids)
        const speed = screen.getByRole('combobox', { name: 'Fast Mode' })
        expect(within(speed).getByRole('option', { name: 'Fast' })).toBeDisabled()
        fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning effort' }), { target: { value: ids[1] } })
        expect(onChange).toHaveBeenCalledWith(ids[1])
        expect(screen.queryByRole('combobox', { name: 'Variant' })).toBeNull()
    })

    it('retains every coupled configuration without synthesizing combinations', () => {
        const ids = ['a[thinking=false,context=32k]', 'a[thinking=true,context=64k]']
        const onChange = show(ids)
        const select = screen.getByRole('combobox', { name: 'Variant' })
        fireEvent.change(select, { target: { value: ids[1] } })
        expect(onChange).toHaveBeenCalledWith(ids[1])
    })

    it('keeps an unrecognized current model unselected until a user chooses an advertised variant', () => {
        const onChange = show(['a[custom=one]', 'a[custom=two]'], 'a[custom=three]')
        expect(screen.getByRole('combobox', { name: 'Variant' })).toHaveValue('')
        expect(onChange).not.toHaveBeenCalled()
    })

    it('disables parameter controls when the session is busy', () => {
        show(['composer-2.5', 'composer-2.5-fast'], 'composer-2.5', true)
        expect(screen.getByRole('combobox', { name: 'Fast Mode' })).toBeDisabled()
    })
})
