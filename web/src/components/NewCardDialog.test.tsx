import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NewCardDialog, type NewCardDialogProps } from './NewCardDialog'
import { ApiError } from '@/api/client'
import type { IssueTemplate } from '@/types/api'

function renderDialog(overrides: Partial<NewCardDialogProps> = {}) {
    const props: NewCardDialogProps = {
        isOpen: true,
        onClose: vi.fn(),
        knownRepos: [],
        templates: [],
        blankAllowed: true,
        githubNewIssueUrl: null,
        isLoadingTemplates: false,
        templatesError: null,
        onRepoChange: vi.fn(),
        onSubmit: vi.fn().mockResolvedValue('https://github.com/heavygee/hapi/issues/42'),
        ...overrides
    }
    return { ...render(<I18nProvider><NewCardDialog {...props} /></I18nProvider>), props }
}

afterEach(() => cleanup())

const FORM_TEMPLATE: IssueTemplate = {
    id: 'bug_report.yml',
    name: 'Bug report',
    description: 'File a bug',
    titlePrefix: '[Bug]: ',
    labels: ['bug'],
    assignees: ['octocat'],
    kind: 'form',
    fields: [
        { kind: 'markdown', value: 'Thanks for filing!' },
        { kind: 'input', id: 'contact', label: 'Contact', required: false }
    ]
}

const TEMPLATE_WITH_DEFAULTS: IssueTemplate = {
    id: 'defaults.yml',
    name: 'Has defaults',
    labels: [],
    assignees: [],
    kind: 'form',
    fields: [
        { kind: 'input', id: 'env', label: 'Environment', value: 'production', required: true },
        { kind: 'dropdown', id: 'severity', label: 'Severity', options: ['Low', 'High'], multiple: false, defaultIndex: 1, required: true }
    ]
}

const UNSUPPORTED_TEMPLATE: IssueTemplate = {
    id: 'weird.yml',
    name: 'Weird form',
    kind: 'unsupported',
    reason: 'Uses a form feature not supported yet'
}

describe('NewCardDialog', () => {
    it('walks repo -> template -> form -> review -> submit for a structured form template', async () => {
        const onRepoChange = vi.fn()
        const onSubmit = vi.fn().mockResolvedValue('https://github.com/heavygee/hapi/issues/42')
        const { props } = renderDialog({ templates: [FORM_TEMPLATE], onRepoChange, onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        expect(onRepoChange).toHaveBeenCalledWith('heavygee/hapi')

        fireEvent.click(await screen.findByText('Bug report'))

        expect(screen.getByText('Thanks for filing!')).toBeInTheDocument()
        // The template's title is seeded directly into the editable input as
        // a default, not held back as a placeholder behind an unremovable
        // prefix — the user's full edit replaces it outright.
        const titleInput = screen.getAllByRole('textbox')[0]! as HTMLInputElement
        expect(titleInput.value).toBe('[Bug]: ')
        fireEvent.change(titleInput, { target: { value: '[Bug]: Everything is broken' } })
        fireEvent.change(screen.getAllByRole('textbox')[1]!, { target: { value: 'me@example.com' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))

        expect(screen.getByText('[Bug]: Everything is broken')).toBeInTheDocument()
        expect(screen.getByText('bug')).toBeInTheDocument()
        expect(screen.getByText('octocat')).toBeInTheDocument()
        expect(screen.getByText(/### Contact/)).toBeInTheDocument()
        expect(screen.getByText(/me@example.com/)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledWith({
                repo: 'heavygee/hapi',
                title: '[Bug]: Everything is broken',
                body: '### Contact\n\nme@example.com',
                labels: ['bug'],
                assignees: ['octocat']
            })
            expect(props.onClose).toHaveBeenCalledOnce()
        })
    })

    // Review finding: GitHub's template `title` is a pre-populated DEFAULT,
    // not an unavoidable prefix outside the editable input — the user must
    // be able to replace it outright or clear it entirely, not just append
    // after it.
    it('lets the user replace or clear the template\'s default title entirely', async () => {
        const onSubmit = vi.fn().mockResolvedValue('https://github.com/heavygee/hapi/issues/42')
        renderDialog({ templates: [FORM_TEMPLATE], onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Bug report'))

        const titleInput = screen.getAllByRole('textbox')[0]! as HTMLInputElement
        expect(titleInput.value).toBe('[Bug]: ')
        fireEvent.change(titleInput, { target: { value: 'Totally unrelated title' } })
        expect(titleInput.value).toBe('Totally unrelated title')

        fireEvent.change(screen.getAllByRole('textbox')[1]!, { target: { value: 'me@example.com' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
                title: 'Totally unrelated title'
            }))
        })
    })

    it('counts a field\'s own prefilled default as answered — the user never has to re-type it to submit', async () => {
        const onSubmit = vi.fn().mockResolvedValue('https://github.com/heavygee/hapi/issues/44')
        renderDialog({ templates: [TEMPLATE_WITH_DEFAULTS], onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Has defaults'))

        // Both required fields already show their template defaults —
        // nothing touched yet, but Next must not be disabled.
        fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'A title' } })
        const nextButton = screen.getByRole('button', { name: 'Next' })
        expect(nextButton).not.toBeDisabled()
        fireEvent.click(nextButton)

        expect(screen.getByText(/### Environment/)).toBeInTheDocument()
        expect(screen.getByText(/production/)).toBeInTheDocument()
        expect(screen.getByText(/### Severity/)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
            body: '### Environment\n\nproduction\n\n### Severity\n\nHigh'
        })))
    })

    // Review finding: validations.min_length was parsed but never enforced —
    // a single character satisfied a required field's non-emptiness check
    // even when GitHub's own form (and this repo's maintainer) demands a
    // much longer answer.
    it('blocks Next until a required field with min_length is long enough', async () => {
        const template: IssueTemplate = {
            id: 'repro.yml',
            name: 'Needs repro',
            labels: [],
            assignees: [],
            kind: 'form',
            fields: [
                { kind: 'textarea', id: 'repro', label: 'Reproduction steps', required: true, minLength: 10 }
            ]
        }
        renderDialog({ templates: [template] })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Needs repro'))

        fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'A title' } })
        const textarea = screen.getAllByRole('textbox')[1]!
        const nextButton = screen.getByRole('button', { name: 'Next' })

        fireEvent.change(textarea, { target: { value: 'short' } })
        expect(nextButton).toBeDisabled()

        fireEvent.change(textarea, { target: { value: 'long enough now' } })
        expect(nextButton).not.toBeDisabled()
    })

    it('offers "Open a blank issue" when allowed, with a free-text body', async () => {
        const onSubmit = vi.fn().mockResolvedValue('https://github.com/heavygee/hapi/issues/43')
        renderDialog({ templates: [], blankAllowed: true, onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Open a blank issue'))

        const titleInput = screen.getAllByRole('textbox')[0]!
        fireEvent.change(titleInput, { target: { value: 'A plain title' } })
        const bodyTextarea = screen.getByLabelText('Description')
        fireEvent.change(bodyTextarea, { target: { value: 'Plain body text' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledWith({
                repo: 'heavygee/hapi',
                title: 'A plain title',
                body: 'Plain body text',
                labels: [],
                assignees: []
            })
        })
    })

    it('does not offer "Open a blank issue" when blankAllowed is false but a usable template exists', async () => {
        renderDialog({ templates: [FORM_TEMPLATE], blankAllowed: false })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))

        await screen.findByText('Bug report')
        expect(screen.queryByText('Open a blank issue')).toBeNull()
    })

    it('blocks creation and offers GitHub\'s own chooser when blank is disabled and nothing parsed as usable', async () => {
        renderDialog({
            templates: [UNSUPPORTED_TEMPLATE],
            blankAllowed: false,
            githubNewIssueUrl: 'https://github.com/heavygee/hapi/issues/new/choose'
        })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))

        expect(await screen.findByText('This repository does not accept blank issues.')).toBeInTheDocument()
        expect(screen.getByText('Weird form')).toBeInTheDocument()
        expect(screen.getByText('Uses a form feature not supported yet')).toBeInTheDocument()
        expect(screen.queryByText('Bug report')).toBeNull()
        expect(screen.queryByText('Open a blank issue')).toBeNull()
        const link = screen.getByRole('link', { name: 'Open on GitHub instead' })
        expect(link).toHaveAttribute('href', 'https://github.com/heavygee/hapi/issues/new/choose')
    })

    it('shows a no-templates message in the blocked state when the repo has none at all', async () => {
        renderDialog({ templates: [], blankAllowed: false, githubNewIssueUrl: null })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))

        expect(await screen.findByText('No issue templates were found in this repository.')).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Open on GitHub instead' })).toBeNull()
    })

    it('lists an unsupported template disabled with its reason, not selectable', async () => {
        renderDialog({ templates: [FORM_TEMPLATE, UNSUPPORTED_TEMPLATE] })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))

        await screen.findByText('Bug report')
        expect(screen.getByText('Weird form')).toBeInTheDocument()
        expect(screen.getByText('Uses a form feature not supported yet')).toBeInTheDocument()
        // Unsupported entries render as a plain div (no onClick), not a button.
        expect(screen.getByText('Weird form').closest('button')).toBeNull()
    })

    it('disables Next on the repo step until something is typed', () => {
        renderDialog()
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'a/b' } })
        expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
    })

    it('offers a dropdown of known repos plus an "Other repository" free-text fallback', () => {
        renderDialog({ knownRepos: ['heavygee/hapi', 'heavygee/other'] })
        expect(screen.getByRole('combobox')).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'heavygee/hapi' })).toBeInTheDocument()
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '__other__' } })
        expect(screen.getByPlaceholderText('owner/repo')).toBeInTheDocument()
    })

    it('shows the templates error and does not crash when the fetch failed', async () => {
        renderDialog({ templatesError: 'rate limited' })
        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        expect(await screen.findByText('rate limited')).toBeInTheDocument()
    })

    it('surfaces a submit failure inline on the review step without closing the dialog', async () => {
        const onSubmit = vi.fn().mockRejectedValue(new Error('gh issue create failed'))
        const { props } = renderDialog({ templates: [], blankAllowed: true, onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Open a blank issue'))
        fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'T' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        await waitFor(() => expect(screen.getByText('gh issue create failed')).toBeInTheDocument())
        expect(props.onClose).not.toHaveBeenCalled()
    })

    // Operator feedback: onSubmit can now take several seconds (polling for
    // GitHub Projects v2's own item-add propagation lag) — a bare text swap
    // reads as "did my click even register" over that kind of wait. The
    // button needs a visible spinner, not just different words.
    it('shows a spinner on the Create issue button while the async submit is in flight', async () => {
        let resolveSubmit: (() => void) | undefined
        const onSubmit = vi.fn(() => new Promise<string>((resolve) => {
            resolveSubmit = () => resolve('https://github.com/heavygee/hapi/issues/42')
        }))
        renderDialog({ templates: [], blankAllowed: true, onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Open a blank issue'))
        fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'T' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        const button = await screen.findByRole('button', { name: 'Creating…' })
        expect(button).toBeDisabled()
        expect(button).toHaveAttribute('aria-busy', 'true')
        expect(button.querySelector('svg')).not.toBeNull()

        resolveSubmit?.()
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Creating…' })).not.toBeInTheDocument())
    })

    it('surfaces the orphaned issue\'s own URL as a link when the issue was created but adding it to the board failed', async () => {
        const apiError = new ApiError('HTTP 502', 502, undefined, JSON.stringify({
            error: 'Issue created at https://github.com/heavygee/hapi/issues/42 but could not be added to the board: boom',
            url: 'https://github.com/heavygee/hapi/issues/42'
        }))
        const onSubmit = vi.fn().mockRejectedValue(apiError)
        const { props } = renderDialog({ templates: [], blankAllowed: true, onSubmit })

        fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'heavygee/hapi' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(await screen.findByText('Open a blank issue'))
        fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'T' } })
        fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

        const link = await screen.findByRole('link', { name: 'https://github.com/heavygee/hapi/issues/42' })
        expect(link).toHaveAttribute('href', 'https://github.com/heavygee/hapi/issues/42')
        expect(props.onClose).not.toHaveBeenCalled()
    })
})
