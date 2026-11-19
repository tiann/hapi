import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { LoginPrompt } from './LoginPrompt'

afterEach(cleanup)
it('shows recovery without asking for a saved credential and permits an explicit retry', () => {
    const retry = vi.fn()
    render(<I18nProvider><LoginPrompt mode="reconnect" onReconnect={retry} error="Cannot reach the hub."
        baseUrl="https://hub.test" serverUrl={null} setServerUrl={vi.fn()} clearServerUrl={vi.fn()} /></I18nProvider>)
    expect(screen.getByText('Reconnecting to hub')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Cannot reach the hub.')
    expect(document.querySelector('input[type="password"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /^Hub / })).toBeNull()
    expect(document.querySelector('input[type="url"]')).toBeNull()
})
it('retains the credential form for a real authentication rejection', () => {
    render(<I18nProvider><LoginPrompt error="Unauthorized" onLogin={vi.fn()}
        baseUrl="https://hub.test" serverUrl={null} setServerUrl={vi.fn()} clearServerUrl={vi.fn()} /></I18nProvider>)
    expect(document.querySelector('input[type="password"]')).not.toBeNull()
    expect(screen.queryByText('Reconnecting to hub')).toBeNull()
})
