import { describe, expect, it } from 'bun:test'
import { formatIssueBody, initialAnswersForFields, isUsableIssueTemplate, type IssueFormField } from './issueTemplates'

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
            { kind: 'checkboxes', id: 'terms', label: 'Terms', options: [{ label: 'Agree', required: true }] }
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

    it('does not seed a multi-select dropdown even if defaultIndex is somehow present', () => {
        const fields: IssueFormField[] = [{ kind: 'dropdown', id: 'browsers', label: 'Browsers', options: ['Firefox', 'Chrome'], multiple: true, defaultIndex: 0, required: false }]
        expect(initialAnswersForFields(fields)).toEqual([])
    })

    it('skips fields with no default: markdown, unset input/textarea, dropdown with no defaultIndex, checkboxes', () => {
        const fields: IssueFormField[] = [
            { kind: 'markdown', value: 'hi' },
            { kind: 'input', id: 'a', label: 'A', required: false },
            { kind: 'dropdown', id: 'b', label: 'B', options: ['x'], multiple: false, required: false },
            { kind: 'checkboxes', id: 'c', label: 'C', options: [{ label: 'opt', required: false }] }
        ]
        expect(initialAnswersForFields(fields)).toEqual([])
    })
})

describe('isUsableIssueTemplate', () => {
    it('excludes unsupported templates, includes form and legacy templates', () => {
        expect(isUsableIssueTemplate({ id: 'a', name: 'A', kind: 'unsupported', reason: 'nope' })).toBe(false)
        expect(isUsableIssueTemplate({ id: 'b', name: 'B', kind: 'form', fields: [], labels: [], assignees: [] })).toBe(true)
        expect(isUsableIssueTemplate({ id: 'c', name: 'C', kind: 'legacy', body: '', labels: [], assignees: [] })).toBe(true)
    })
})
