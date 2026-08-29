import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { RenameSessionDialog } from './RenameSessionDialog'
import { SessionExportDialog } from './SessionExportDialog'
import { UriConfirmDialog } from './UriConfirmDialog'

function renderWithProviders(content: React.ReactNode) {
    return render(
        <I18nProvider>
            <ToastProvider>{content}</ToastProvider>
        </I18nProvider>
    )
}

afterEach(() => cleanup())

function expectCenteredTitle(name: string) {
    const dialog = screen.getByRole('dialog')
    const title = within(dialog).getByRole('heading', { name })

    expect(title.parentElement).toHaveClass('pr-0')
    expect(title).toHaveClass('min-h-6', 'px-10', 'text-center', 'leading-6')
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-3', 'h-8')
}

describe('session dialog title alignment', () => {
    it('centers the rename dialog title on the close button centerline', () => {
        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                isPending={false}
            />
        )

        expectCenteredTitle('Rename Session')
    })

    it('places Generate before Cancel and Save', () => {
        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={async () => 'Generated title'}
                onUpdateSummary={vi.fn(async () => {})}
                isPending={false}
            />
        )

        expect(within(screen.getByRole('dialog')).getAllByRole('button').map((button) => button.textContent)).toEqual([
            'Generate',
            'Cancel',
            'Save',
            ''
        ])
    })

    it('explains how to configure an unavailable title provider', async () => {
        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={async () => {
                    throw new ApiError('not configured', 503, 'unavailable')
                }}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

        await waitFor(() => expect(screen.getByText(/HAPI_TITLE_PROVIDER_BASE_URL/)).toBeInTheDocument())
        expect(screen.getByText(/titleProvider\.baseUrl/)).toBeInTheDocument()
    })

    it('uses the generic error for a provider failure with HTTP 503', async () => {
        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={async () => {
                    throw new ApiError('provider unavailable', 503, 'provider')
                }}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

        await waitFor(() => expect(screen.getByText('Failed to generate a title. Please try again.')).toBeInTheDocument())
        expect(screen.queryByText(/HAPI_TITLE_PROVIDER_BASE_URL/)).not.toBeInTheDocument()
    })

    it('shows a safe provider failure reason returned by the Hub', async () => {
        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={async () => {
                    throw new ApiError(
                        'HTTP 502 Bad Gateway',
                        502,
                        'provider',
                        JSON.stringify({
                            error: 'Title provider request failed (HTTP 404): endpoint or model not found',
                            code: 'provider'
                        })
                    )
                }}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

        await waitFor(() => expect(screen.getByText(
            'Failed to generate a title: Title provider request failed (HTTP 404): endpoint or model not found'
        )).toBeInTheDocument())
    })

    it('keeps Save disabled but does not show Saving while generating', async () => {
        let resolveSuggestion!: (title: string) => void
        const onSuggestTitle = vi.fn(() => new Promise<string>((resolve) => {
            resolveSuggestion = resolve
        }))
        const view = renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={onSuggestTitle}
                onUpdateSummary={vi.fn(async () => {})}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('button', { name: /^Generating/ })).toBeDisabled())

        view.rerender(
            <I18nProvider>
                <ToastProvider>
                    <RenameSessionDialog
                        isOpen={true}
                        onClose={vi.fn()}
                        currentName="Session"
                        onRename={vi.fn(async () => {})}
                        onSuggestTitle={onSuggestTitle}
                        onUpdateSummary={vi.fn(async () => {})}
                        isPending={true}
                    />
                </ToastProvider>
            </I18nProvider>
        )

        const save = screen.getByRole('button', { name: 'Save' })
        expect(save).toBeDisabled()
        expect(screen.queryByRole('button', { name: 'Saving' })).not.toBeInTheDocument()

        resolveSuggestion('Generated title')
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated title'))
    })

    it('saves an untouched generated draft as metadata.summary.text', async () => {
        const onRename = vi.fn(async () => {})
        const onUpdateSummary = vi.fn(async () => {})

        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={onRename}
                onSuggestTitle={async () => 'Generated title'}
                onUpdateSummary={onUpdateSummary}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated title'))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(onUpdateSummary).toHaveBeenCalledWith('Generated title', true))
        expect(onRename).not.toHaveBeenCalled()
    })

    it('trims whitespace around a generated title before saving', async () => {
        const onUpdateSummary = vi.fn(async () => {})

        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={async () => '  Generated title  '}
                onUpdateSummary={onUpdateSummary}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated title'))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(onUpdateSummary).toHaveBeenCalledWith('Generated title', true))
    })

    it('treats any edit to a generated draft as a manual metadata.name rename', async () => {
        const onRename = vi.fn(async () => {})
        const onUpdateSummary = vi.fn(async () => {})

        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={onRename}
                onSuggestTitle={async () => 'Generated title'}
                onUpdateSummary={onUpdateSummary}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated title'))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My own title' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(onRename).toHaveBeenCalledWith('My own title'))
        expect(onUpdateSummary).not.toHaveBeenCalled()
    })

    it('keeps a generated draft manual when the user edits it back to the current title', async () => {
        const onRename = vi.fn(async () => {})
        const onUpdateSummary = vi.fn(async () => {})

        renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={vi.fn()}
                currentName="Session"
                onRename={onRename}
                onSuggestTitle={async () => 'Generated title'}
                onUpdateSummary={onUpdateSummary}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated title'))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited title' } })
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Session' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(onRename).toHaveBeenCalledWith('Session'))
        expect(onUpdateSummary).not.toHaveBeenCalled()
    })

    it('ignores a generated result after the dialog closes and reopens', async () => {
        let resolveSuggestion: ((title: string) => void) | undefined
        const onSuggestTitle = vi.fn(() => new Promise<string>((resolve) => {
            resolveSuggestion = resolve
        }))
        const onClose = vi.fn()
        const { rerender } = renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={onClose}
                currentName="Session"
                onRename={vi.fn(async () => {})}
                onSuggestTitle={onSuggestTitle}
                onUpdateSummary={vi.fn(async () => {})}
                isPending={false}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(onSuggestTitle).toHaveBeenCalledOnce())
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        rerender(
            <I18nProvider>
                <ToastProvider>
                    <RenameSessionDialog
                        isOpen={false}
                        onClose={onClose}
                        currentName="Session"
                        onRename={vi.fn(async () => {})}
                        onSuggestTitle={onSuggestTitle}
                        onUpdateSummary={vi.fn(async () => {})}
                        isPending={false}
                    />
                </ToastProvider>
            </I18nProvider>
        )
        rerender(
            <I18nProvider>
                <ToastProvider>
                    <RenameSessionDialog
                        isOpen={true}
                        onClose={onClose}
                        currentName="Session"
                        onRename={vi.fn(async () => {})}
                        onSuggestTitle={onSuggestTitle}
                        onUpdateSummary={vi.fn(async () => {})}
                        isPending={false}
                    />
                </ToastProvider>
            </I18nProvider>
        )

        resolveSuggestion?.('Stale title')
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Session'))
        expect(screen.getByRole('textbox')).not.toHaveValue('Stale title')
    })

    it('uses metadata.name for direct manual input and does not save on cancel', async () => {
        const onRename = vi.fn(async () => {})
        const onUpdateSummary = vi.fn(async () => {})
        const onClose = vi.fn()

        const { rerender } = renderWithProviders(
            <RenameSessionDialog
                isOpen={true}
                onClose={onClose}
                currentName="Session"
                onRename={onRename}
                onSuggestTitle={async () => 'Generated title'}
                onUpdateSummary={onUpdateSummary}
                isPending={false}
            />
        )

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Manual title' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(onRename).toHaveBeenCalledWith('Manual title'))
        expect(onUpdateSummary).not.toHaveBeenCalled()

        rerender(
            <I18nProvider>
                <ToastProvider>
                    <RenameSessionDialog
                        isOpen={true}
                        onClose={onClose}
                        currentName="Session"
                        onRename={onRename}
                        onSuggestTitle={async () => 'Generated title'}
                        onUpdateSummary={onUpdateSummary}
                        isPending={false}
                    />
                </ToastProvider>
            </I18nProvider>
        )
        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated title'))
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onUpdateSummary).not.toHaveBeenCalled()
    })

    it('centers the export dialog title on the close button centerline', () => {
        renderWithProviders(
            <SessionExportDialog
                isOpen={true}
                onClose={vi.fn()}
                sessionId="session-1"
                api={null}
            />
        )

        expectCenteredTitle('Export conversation')
    })

    it('centers the external-link dialog title on the close button centerline', () => {
        renderWithProviders(
            <UriConfirmDialog
                open={true}
                url="obsidian://open"
                scheme="obsidian"
                onCancel={vi.fn()}
                onOpen={vi.fn()}
                onAlwaysAllow={vi.fn()}
            />
        )

        expectCenteredTitle('Open this link?')
    })
})
