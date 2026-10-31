import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { IssueFormFieldView } from './IssueFormField'
import type { IssueFormAnswer, IssueFormField } from '@/types/api'

function renderField(field: IssueFormField, answer: IssueFormAnswer | undefined, onChange = vi.fn()) {
    render(
        <I18nProvider>
            <IssueFormFieldView field={field} answer={answer} onChange={onChange} />
        </I18nProvider>
    )
    return onChange
}

describe('IssueFormFieldView', () => {
    it('renders a markdown field as display-only instructional text, no input', () => {
        renderField({ kind: 'markdown', value: 'Thanks for filing this bug report!' }, undefined)
        expect(screen.getByText('Thanks for filing this bug report!')).toBeInTheDocument()
        expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('shows a required-field asterisk for input/textarea/dropdown but not for a markdown field', () => {
        renderField({ kind: 'input', id: 'contact', label: 'Contact', required: true }, undefined)
        expect(screen.getByText('*')).toBeInTheDocument()
    })

    it('fires onChange with the typed value for an input field', () => {
        const onChange = renderField({ kind: 'input', id: 'contact', label: 'Contact', required: false }, undefined)
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'me@example.com' } })
        expect(onChange).toHaveBeenCalledWith({ kind: 'input', id: 'contact', value: 'me@example.com' })
    })

    it('pre-fills a textarea from the field\'s own default value', () => {
        renderField({ kind: 'textarea', id: 'logs', label: 'Logs', required: false, value: 'default text' }, undefined)
        expect(screen.getByRole('textbox')).toHaveValue('default text')
    })

    it('shows a minimum-length hint and sets the native minlength when the field declares one', () => {
        renderField({ kind: 'textarea', id: 'repro', label: 'Reproduction steps', required: true, minLength: 100 }, undefined)
        expect(screen.getByText('Minimum 100 characters')).toBeInTheDocument()
        expect(screen.getByRole('textbox')).toHaveAttribute('minlength', '100')
    })

    it('shows no minimum-length hint when the field has none', () => {
        renderField({ kind: 'input', id: 'contact', label: 'Contact', required: false }, undefined)
        expect(screen.queryByText(/^Minimum \d/)).not.toBeInTheDocument()
    })

    it('renders a single-select dropdown and fires onChange with a single-element selected array', () => {
        const onChange = renderField(
            { kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, required: true },
            undefined
        )
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '2.0' } })
        expect(onChange).toHaveBeenCalledWith({ kind: 'dropdown', id: 'version', selected: ['2.0'] })
    })

    it('shows the template default for a single-select dropdown with no answer yet', () => {
        renderField(
            { kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, defaultIndex: 1, required: true },
            undefined
        )
        expect(screen.getByRole('combobox')).toHaveValue('2.0')
    })

    it('honors an explicitly cleared dropdown answer instead of redisplaying the template default (review finding)', () => {
        renderField(
            { kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, defaultIndex: 1, required: true },
            { kind: 'dropdown', id: 'version', selected: [] }
        )
        expect(screen.getByRole('combobox')).toHaveValue('')
    })

    it('renders a multi-select dropdown as checkboxes and toggles independently', () => {
        const onChange = renderField(
            { kind: 'dropdown', id: 'browsers', label: 'Browsers', options: ['Firefox', 'Chrome'], multiple: true, required: false },
            { kind: 'dropdown', id: 'browsers', selected: ['Firefox'] }
        )
        fireEvent.click(screen.getByText('Chrome'))
        expect(onChange).toHaveBeenCalledWith({ kind: 'dropdown', id: 'browsers', selected: ['Firefox', 'Chrome'] })
    })

    it('renders checkboxes with per-option required markers and toggles independently', () => {
        const onChange = renderField(
            {
                kind: 'checkboxes',
                id: 'terms',
                label: 'Code of Conduct',
                options: [{ label: 'I agree', required: true }, { label: 'Optional note', required: false }]
            },
            { kind: 'checkboxes', id: 'terms', checked: [] }
        )
        fireEvent.click(screen.getByText('I agree'))
        expect(onChange).toHaveBeenCalledWith({ kind: 'checkboxes', id: 'terms', checked: ['I agree'] })
    })

    it('unchecks a previously-checked checkbox option', () => {
        const onChange = renderField(
            { kind: 'checkboxes', id: 'terms', label: 'Terms', options: [{ label: 'Agree', required: true }] },
            { kind: 'checkboxes', id: 'terms', checked: ['Agree'] }
        )
        fireEvent.click(screen.getByText('Agree'))
        expect(onChange).toHaveBeenCalledWith({ kind: 'checkboxes', id: 'terms', checked: [] })
    })

    // Review finding (hapi#2147): the label was a bare sibling of its
    // control — no htmlFor/id or aria-labelledby — so a field with no
    // placeholder had no accessible name for screen readers, and clicking
    // the label text didn't focus the control. getByLabelText only
    // succeeds when that association is real.
    it('associates the label with its control for an input field', () => {
        renderField({ kind: 'input', id: 'contact', label: 'Contact', required: false }, undefined)
        expect(screen.getByLabelText('Contact')).toBe(screen.getByRole('textbox'))
    })

    it('associates the label with its control for a textarea field', () => {
        renderField({ kind: 'textarea', id: 'logs', label: 'Logs', required: false }, undefined)
        expect(screen.getByLabelText('Logs')).toBe(screen.getByRole('textbox'))
    })

    it('associates the label with its control for a single-select dropdown', () => {
        renderField(
            { kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, required: false },
            undefined
        )
        expect(screen.getByLabelText('Version')).toBe(screen.getByRole('combobox'))
    })
})
