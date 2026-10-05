import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

function view(mode: 'queue' | 'steer', change: (mode: 'queue' | 'steer') => Promise<void>) {
    return <I18nProvider><StatusBar active thinking agentState={null} agentFlavor="codex"
        codexPromptMode={mode} onCodexPromptModeChange={change} /></I18nProvider>
}

describe('Codex delivery toggle', () => {
    it('requests the opposite mode and prevents repeat clicks while saving', async () => {
        let resolve!: () => void
        const change = vi.fn(() => new Promise<void>(done => { resolve = done }))
        const { rerender } = render(view('queue', change))
        const button = screen.getByRole('button', { name: 'Switch follow-ups to Steer' })
        fireEvent.click(button)
        expect(change).toHaveBeenCalledWith('steer')
        expect(button).toBeDisabled()
        fireEvent.click(button)
        expect(change).toHaveBeenCalledTimes(1)
        await act(async () => { resolve() })
        rerender(view('steer', change))
        fireEvent.click(screen.getByRole('button', { name: 'Switch follow-ups to Queue' }))
        expect(change).toHaveBeenLastCalledWith('queue')
        await act(async () => { resolve() })
    })

    it('keeps the current mode and shows an error when saving fails', async () => {
        const change = vi.fn().mockRejectedValue(new Error('offline'))
        render(view('queue', change))
        fireEvent.click(screen.getByRole('button', { name: 'Switch follow-ups to Steer' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not change follow-up mode. Try again.'))
        expect(screen.getByRole('button', { name: 'Switch follow-ups to Steer' })).toBeEnabled()
        expect(screen.getByText('Queue')).toBeInTheDocument()
    })
})
