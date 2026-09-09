import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexUsage } from './CodexUsage'
import type { AgentState } from '@/types/api'

it('shows Reserve only while active, with separate ordinary limits and unknown data', () => {
    const usage: NonNullable<AgentState['codexUsage']> = {
        ordinary: { primary: null, secondary: { remainingPercent: 40, windowDurationMins: null, resetsAt: null } },
        reserve: null
    }
    const view = () => <I18nProvider><CodexUsage usage={usage} /></I18nProvider>
    const { rerender } = render(view())
    fireEvent.click(screen.getByRole('button', { name: 'Codex Usage' }))
    expect(screen.queryByText(/Luna Reserve/)).toBeNull()
    expect(screen.getByText('40% remaining')).toBeTruthy()
    usage.reserve = { primary: { remainingPercent: 0, windowDurationMins: 123, resetsAt: 2000000000 }, secondary: { remainingPercent: null, windowDurationMins: null, resetsAt: null } }
    rerender(view())
    expect(screen.getByText('Luna Reserve · GPT-5.6 Luna')).toBeTruthy()
    expect(screen.getByText('40% remaining')).toBeTruthy()
    expect(screen.getByText('0% remaining')).toBeTruthy()
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.getByText(/123 min window/)).toBeTruthy()
    expect(screen.getByText(/Resets/)).toBeTruthy()
    usage.reserve = null
    rerender(view())
    expect(screen.queryByText(/Luna Reserve/)).toBeNull()
})
