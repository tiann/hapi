import { describe, expect, it } from 'bun:test'
import { formatIssueBody, initialAnswersForFields, isUsableIssueTemplate, validateIssueFormAnswers, type IssueFormField } from './issueTemplates'

describe('formatIssueBody', () => {
    it('skips markdown fields entirely (instructional only, no answer)', () => {
        const fields: IssueFormField[] = [
            { kind: 'markdown', value: 'Thanks for filing this!' },
            { kind: 'input', id: 'contact', label: 'Contact', required: false }
        ]
        const body = formatIssueBody(fields, [{ kind: 'input', id: 'contact', value: 'a@b.com' }])
        expect(body).not.toContain('Thanks for filing this')
        expect(body).toBe('### Contact\n\na@b.com')
    })

    it('renders _No response_ for an unanswered optional input/textarea', () => {
        const fields: IssueFormField[] = [
            { kind: 'input', id: 'contact', label: 'Contact', required: false }
        ]
        expect(formatIssueBody(fields, [])).toBe('### Contact\n\n_No response_')
    })

    it('trims whitespace-only answers down to _No response_', () => {
        const fields: IssueFormField[] = [
            { kind: 'input', id: 'contact', label: 'Contact', required: false }
        ]
        expect(formatIssueBody(fields, [{ kind: 'input', id: 'contact', value: '   ' }]))
            .toBe('### Contact\n\n_No response_')
    })

    it('wraps a textarea answer in a code fence when render is set', () => {
        const fields: IssueFormField[] = [
            { kind: 'textarea', id: 'logs', label: 'Logs', required: true, render: 'shell' }
        ]
        const body = formatIssueBody(fields, [{ kind: 'textarea', id: 'logs', value: '$ npm test' }])
        expect(body).toBe('### Logs\n\n```shell\n$ npm test\n```')
    })

    it('leaves a plain textarea answer unfenced', () => {
        const fields: IssueFormField[] = [
            { kind: 'textarea', id: 'what', label: 'What happened?', required: true }
        ]
        const body = formatIssueBody(fields, [{ kind: 'textarea', id: 'what', value: 'It broke.' }])
        expect(body).toBe('### What happened?\n\nIt broke.')
    })

    it('joins multiple dropdown selections with a comma', () => {
        const fields: IssueFormField[] = [
            { kind: 'dropdown', id: 'browsers', label: 'Browsers', options: ['Firefox', 'Chrome', 'Safari'], multiple: true, required: false }
        ]
        const body = formatIssueBody(fields, [{ kind: 'dropdown', id: 'browsers', selected: ['Firefox', 'Chrome'] }])
        expect(body).toBe('### Browsers\n\nFirefox, Chrome')
    })

    it('renders a single-select dropdown with no selection as _No response_', () => {
        const fields: IssueFormField[] = [
            { kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, required: true }
        ]
        expect(formatIssueBody(fields, [])).toBe('### Version\n\n_No response_')
    })

    it('renders checkboxes as a markdown checkbox list, checked vs unchecked', () => {
        const fields: IssueFormField[] = [
            {
                kind: 'checkboxes',
                id: 'terms',
                label: 'Code of Conduct',
                required: false,
                options: [
                    { label: 'I agree to follow the Code of Conduct', required: true },
                    { label: 'I have searched for duplicates', required: false }
                ]
            }
        ]
        const body = formatIssueBody(fields, [{ kind: 'checkboxes', id: 'terms', checked: ['I agree to follow the Code of Conduct'] }])
        expect(body).toBe(
            '### Code of Conduct\n\n- [x] I agree to follow the Code of Conduct\n- [ ] I have searched for duplicates'
        )
    })

    it('renders every unchecked option when no checkboxes answer is present at all', () => {
        const fields: IssueFormField[] = [
            { kind: 'checkboxes', id: 'terms', label: 'Terms', required: false, options: [{ label: 'Agree', required: true }] }
        ]
        expect(formatIssueBody(fields, [])).toBe('### Terms\n\n- [ ] Agree')
    })

    it('joins multiple field sections with a blank line between them', () => {
        const fields: IssueFormField[] = [
            { kind: 'input', id: 'a', label: 'A', required: false },
            { kind: 'input', id: 'b', label: 'B', required: false }
        ]
        const body = formatIssueBody(fields, [
            { kind: 'input', id: 'a', value: 'one' },
            { kind: 'input', id: 'b', value: 'two' }
        ])
        expect(body).toBe('### A\n\none\n\n### B\n\ntwo')
    })
})

describe('initialAnswersForFields', () => {
    it('seeds an answer from an input field\'s own default value', () => {
        const fields: IssueFormField[] = [{ kind: 'input', id: 'contact', label: 'Contact', value: 'me@example.com', required: false }]
        expect(initialAnswersForFields(fields)).toEqual([{ kind: 'input', id: 'contact', value: 'me@example.com' }])
    })

    it('seeds an answer from a textarea field\'s own default value', () => {
        const fields: IssueFormField[] = [{ kind: 'textarea', id: 'logs', label: 'Logs', value: 'nothing yet', required: false }]
        expect(initialAnswersForFields(fields)).toEqual([{ kind: 'textarea', id: 'logs', value: 'nothing yet' }])
    })

    it('seeds a single-select dropdown\'s defaultIndex as its selected option', () => {
        const fields: IssueFormField[] = [{ kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, defaultIndex: 1, required: true }]
        expect(initialAnswersForFields(fields)).toEqual([{ kind: 'dropdown', id: 'version', selected: ['2.0'] }])
    })

    // Regression (bot review, tiann/hapi#2147, follow-up): GitHub's own
    // documented schema defines `default` as a single preselected index
    // with no stated restriction to single-select, and no documented
    // validation error forbids combining it with `multiple: true` — this
    // used to be silently dropped, the same prefill-loss class as the
    // input/textarea case above, one field shape over.
    it('seeds a multi-select dropdown\'s defaultIndex too, as a single-element selection', () => {
        const fields: IssueFormField[] = [{ kind: 'dropdown', id: 'browsers', label: 'Browsers', options: ['Firefox', 'Chrome'], multiple: true, defaultIndex: 0, required: false }]
        expect(initialAnswersForFields(fields)).toEqual([{ kind: 'dropdown', id: 'browsers', selected: ['Firefox'] }])
    })

    it('skips fields with no default: markdown, unset input/textarea, dropdown with no defaultIndex, checkboxes', () => {
        const fields: IssueFormField[] = [
            { kind: 'markdown', value: 'hi' },
            { kind: 'input', id: 'a', label: 'A', required: false },
            { kind: 'dropdown', id: 'b', label: 'B', options: ['x'], multiple: false, required: false },
            { kind: 'checkboxes', id: 'c', label: 'C', required: false, options: [{ label: 'opt', required: false }] }
        ]
        expect(initialAnswersForFields(fields)).toEqual([])
    })
})

describe('validateIssueFormAnswers', () => {
    it('passes when every required field is answered and skips markdown', () => {
        const fields: IssueFormField[] = [
            { kind: 'markdown', value: 'hi' },
            { kind: 'input', id: 'contact', label: 'Contact', required: true }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'input', id: 'contact', value: 'me@example.com' }])).toEqual({ valid: true })
    })

    it('rejects a required input/textarea left blank', () => {
        const fields: IssueFormField[] = [{ kind: 'input', id: 'contact', label: 'Contact', required: true }]
        expect(validateIssueFormAnswers(fields, [])).toEqual({ valid: false, fieldLabel: 'Contact' })
    })

    it('rejects an answer shorter than min_length even when non-empty', () => {
        const fields: IssueFormField[] = [{ kind: 'textarea', id: 'logs', label: 'Logs', required: true, minLength: 10 }]
        expect(validateIssueFormAnswers(fields, [{ kind: 'textarea', id: 'logs', value: 'short' }])).toEqual({ valid: false, fieldLabel: 'Logs' })
    })

    it('does not apply min_length to a blank answer on an optional field', () => {
        const fields: IssueFormField[] = [{ kind: 'input', id: 'extra', label: 'Extra', required: false, minLength: 10 }]
        expect(validateIssueFormAnswers(fields, [])).toEqual({ valid: true })
    })

    it('rejects a required dropdown with nothing selected', () => {
        const fields: IssueFormField[] = [{ kind: 'dropdown', id: 'version', label: 'Version', options: ['1.0', '2.0'], multiple: false, required: true }]
        expect(validateIssueFormAnswers(fields, [])).toEqual({ valid: false, fieldLabel: 'Version' })
    })

    it('rejects a checkbox group missing a required option', () => {
        const fields: IssueFormField[] = [
            { kind: 'checkboxes', id: 'terms', label: 'Code of Conduct', required: false, options: [{ label: 'I agree', required: true }] }
        ]
        expect(validateIssueFormAnswers(fields, [])).toEqual({ valid: false, fieldLabel: 'Code of Conduct' })
    })

    it('passes a checkbox group once its required option is checked, ignoring optional ones', () => {
        const fields: IssueFormField[] = [
            {
                kind: 'checkboxes', id: 'terms', label: 'Code of Conduct', required: false,
                options: [{ label: 'I agree', required: true }, { label: 'Optional', required: false }]
            }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'checkboxes', id: 'terms', checked: ['I agree'] }])).toEqual({ valid: true })
    })

    // Review finding (tiann/hapi#2147, follow-up): a checkbox GROUP can be
    // required on its own (`validations.required`) with no individually
    // required option — the old check only ever looked at per-option
    // required, so a group like this accepted an entirely empty selection.
    it('rejects an entirely empty selection on a group-required checkbox group with no individually-required options', () => {
        const fields: IssueFormField[] = [
            { kind: 'checkboxes', id: 'terms', label: 'Code of Conduct', required: true, options: [{ label: 'Just a note', required: false }] }
        ]
        expect(validateIssueFormAnswers(fields, [])).toEqual({ valid: false, fieldLabel: 'Code of Conduct' })
    })

    it('passes a group-required checkbox group once any option is checked', () => {
        const fields: IssueFormField[] = [
            { kind: 'checkboxes', id: 'terms', label: 'Code of Conduct', required: true, options: [{ label: 'Just a note', required: false }] }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'checkboxes', id: 'terms', checked: ['Just a note'] }])).toEqual({ valid: true })
    })

    // Regression (bot review, tiann/hapi#2147, follow-up): a checked value
    // outside the field's own declared options used to satisfy the
    // group-required check purely by being non-empty, while formatIssueBody
    // then renders every real option as unchecked (none of them match the
    // undeclared value) — the hub would file an issue with its required
    // group reading as entirely unanswered.
    it('rejects a checkbox selection that is not one of the field\'s own declared options, even when it satisfies group-required', () => {
        const fields: IssueFormField[] = [
            { kind: 'checkboxes', id: 'terms', label: 'Code of Conduct', required: true, options: [{ label: 'I agree', required: false }] }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'checkboxes', id: 'terms', checked: ['not a real option'] }])).toEqual({ valid: false, fieldLabel: 'Code of Conduct' })
    })

    it('rejects a dropdown selection that is not one of the field\'s own declared options', () => {
        const fields: IssueFormField[] = [
            { kind: 'dropdown', id: 'severity', label: 'Severity', options: ['Low', 'High'], multiple: false, required: false }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'dropdown', id: 'severity', selected: ['Critical'] }]))
            .toEqual({ valid: false, fieldLabel: 'Severity' })
    })

    it('rejects more than one selection on a single-select dropdown', () => {
        const fields: IssueFormField[] = [
            { kind: 'dropdown', id: 'severity', label: 'Severity', options: ['Low', 'High'], multiple: false, required: false }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'dropdown', id: 'severity', selected: ['Low', 'High'] }]))
            .toEqual({ valid: false, fieldLabel: 'Severity' })
    })

    it('allows multiple valid selections on a multi-select dropdown', () => {
        const fields: IssueFormField[] = [
            { kind: 'dropdown', id: 'browsers', label: 'Browsers', options: ['Firefox', 'Chrome', 'Safari'], multiple: true, required: false }
        ]
        expect(validateIssueFormAnswers(fields, [{ kind: 'dropdown', id: 'browsers', selected: ['Firefox', 'Chrome'] }]))
            .toEqual({ valid: true })
    })

    it('passes an optional dropdown left entirely unanswered', () => {
        const fields: IssueFormField[] = [
            { kind: 'dropdown', id: 'severity', label: 'Severity', options: ['Low', 'High'], multiple: false, required: false }
        ]
        expect(validateIssueFormAnswers(fields, [])).toEqual({ valid: true })
    })
})

describe('isUsableIssueTemplate', () => {
    it('excludes unsupported templates, includes form and legacy templates', () => {
        expect(isUsableIssueTemplate({ id: 'a', name: 'A', kind: 'unsupported', reason: 'nope', githubValid: true })).toBe(false)
        expect(isUsableIssueTemplate({ id: 'b', name: 'B', kind: 'form', fields: [], labels: [], assignees: [], revision: 'r1' })).toBe(true)
        expect(isUsableIssueTemplate({ id: 'c', name: 'C', kind: 'legacy', body: '', labels: [], assignees: [], revision: 'r1' })).toBe(true)
    })
})
