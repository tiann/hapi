import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { EffortField } from './EffortField'

const baseProps = {
    effort: 'auto',
    onEffortChange: vi.fn(),
    reasoningEffort: 'default',
    onReasoningEffortChange: vi.fn(),
    isDisabled: false,
    piSelectedModel: null,
}

describe('EffortField', () => {
    it('renders Grok low/medium/high effort and forwards the selection', () => {
        const onChange = vi.fn()
        const { container } = render(
            <EffortField {...baseProps} agent="grok" onEffortChange={onChange} />
        )
        const select = container.querySelector('select') as HTMLSelectElement

        expect(Array.from(select.options).map((option) => option.value)).toEqual([
            'auto', 'low', 'medium', 'high'
        ])
        fireEvent.change(select, { target: { value: 'low' } })
        expect(onChange).toHaveBeenCalledWith('low')
    })

    it('renders Grok model-dependent options when provided', () => {
        const { container } = render(
            <EffortField
                {...baseProps}
                agent="grok"
                grokOptions={[{ value: 'auto', label: 'Default' }, { value: 'high', label: 'High' }]}
            />
        )
        const select = container.querySelector('select') as HTMLSelectElement
        expect(Array.from(select.options).map((option) => option.value)).toEqual(['auto', 'high'])
    })

    it('renders Claude static effort levels', () => {
        const { container } = render(
            <EffortField {...baseProps} agent="claude" />
        )
        const select = container.querySelector('select') as HTMLSelectElement
        const values = Array.from(select.options).map((option) => option.value)
        expect(values[0]).toBe('auto')
        expect(values).toContain('low')
        expect(values).toContain('high')
    })

    it('renders Pi thinking levels and forwards the selection', () => {
        const onChange = vi.fn()
        const { container } = render(
            <EffortField {...baseProps} agent="pi" onEffortChange={onChange} />
        )
        const select = container.querySelector('select') as HTMLSelectElement
        const values = Array.from(select.options).map((option) => option.value)
        expect(values[0]).toBe('auto')
        expect(values).toEqual([
            'auto', 'off', 'minimal', 'low', 'medium', 'high'
        ])
        fireEvent.change(select, { target: { value: 'high' } })
        expect(onChange).toHaveBeenCalledWith('high')
    })

    it('hides Pi effort when the selected model cannot reason', () => {
        const { container } = render(
            <EffortField {...baseProps} agent="pi" piSelectedModel={{ reasoning: false }} />
        )
        expect(container.querySelector('select')).toBeNull()
    })

    it('filters Pi thinking levels by the selected model thinkingLevelMap', () => {
        const { container } = render(
            <EffortField
                {...baseProps}
                agent="pi"
                piSelectedModel={{
                    reasoning: true,
                    thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' },
                }}
            />
        )
        const select = container.querySelector('select') as HTMLSelectElement
        expect(Array.from(select.options).map((option) => option.value)).toEqual([
            'auto', 'low', 'medium', 'high', 'xhigh', 'max'
        ])
    })

    it('renders Codex reasoning effort options', () => {
        const { container } = render(
            <EffortField {...baseProps} agent="codex" />
        )
        const select = container.querySelector('select') as HTMLSelectElement
        const values = Array.from(select.options).map((option) => option.value)
        expect(values).toContain('default')
        expect(values).toContain('high')
        // Codex static fallback excludes max (reserved for model-dependent lists).
        expect(values).not.toContain('max')
    })

    it('renders nothing for agents without an effort field', () => {
        const { container } = render(
            <EffortField {...baseProps} agent="agy" />
        )
        expect(container.querySelector('select')).toBeNull()
    })
})
