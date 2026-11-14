import { describe, expect, it } from 'bun:test'
import { parseIssueFormYaml, parseIssueTemplateConfig, parseLegacyIssueTemplate } from './issueTemplateParser'

describe('parseIssueFormYaml', () => {
    it('parses a real-shaped bug-report form with every supported field kind', () => {
        const yaml = `
name: Bug report
description: File a bug report
title: "[Bug]: "
labels: ["bug", "triage"]
assignees:
  - octocat
body:
  - type: markdown
    attributes:
      value: Thanks for taking the time to fill this out!
  - type: input
    id: contact
    attributes:
      label: Contact Details
      placeholder: ex. email@example.com
    validations:
      required: false
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      render: shell
    validations:
      required: true
  - type: dropdown
    id: version
    attributes:
      label: Version
      options:
        - "1.0.2"
        - "1.0.3"
      default: 0
    validations:
      required: true
  - type: dropdown
    id: browsers
    attributes:
      label: Browsers
      multiple: true
      options: [Firefox, Chrome, Safari]
  - type: checkboxes
    id: terms
    attributes:
      label: Code of Conduct
      options:
        - label: I agree to follow this project's Code of Conduct
          required: true
`
        const template = parseIssueFormYaml('bug_report.yml', yaml)
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        expect(template.name).toBe('Bug report')
        expect(template.titlePrefix).toBe('[Bug]: ')
        expect(template.labels).toEqual(['bug', 'triage'])
        expect(template.assignees).toEqual(['octocat'])
        expect(template.fields).toHaveLength(6)
        expect(template.fields[0]).toEqual({ kind: 'markdown', value: 'Thanks for taking the time to fill this out!' })
        expect(template.fields[1]).toMatchObject({ kind: 'input', id: 'contact', label: 'Contact Details', required: false })
        expect(template.fields[2]).toMatchObject({ kind: 'textarea', id: 'what-happened', render: 'shell', required: true })
        expect(template.fields[3]).toMatchObject({ kind: 'dropdown', id: 'version', multiple: false, defaultIndex: 0, required: true })
        expect(template.fields[4]).toMatchObject({ kind: 'dropdown', id: 'browsers', multiple: true, required: false })
        expect(template.fields[5]).toMatchObject({
            kind: 'checkboxes',
            id: 'terms',
            options: [{ label: 'I agree to follow this project\'s Code of Conduct', required: true }]
        })
    })

    // Review finding: GitHub's issue-form schema allows labels/assignees as
    // either a YAML list (covered above) or a comma-delimited string, same
    // as the legacy .md frontmatter shorthand parseLegacyIssueTemplate
    // already supports — the structured parser used the stricter array-only
    // helper for these two fields and silently dropped a template's labels
    // and assignees whenever either was written as a plain string.
    it('supports a comma-delimited string form of labels/assignees too', () => {
        const yaml = `
name: Bug report
labels: bug, needs-triage
assignees: octocat
body:
  - type: markdown
    attributes:
      value: Thanks!
`
        const template = parseIssueFormYaml('bug_report.yml', yaml)
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        expect(template.labels).toEqual(['bug', 'needs-triage'])
        expect(template.assignees).toEqual(['octocat'])
    })

    it('marks the whole template unsupported for an unrecognized body-element type, not just drops that field', () => {
        const yaml = `
name: Weird form
body:
  - type: input
    id: known
    attributes:
      label: Known field
  - type: some-future-field-type
    id: unknown
    attributes:
      label: Unknown field
`
        const template = parseIssueFormYaml('weird.yml', yaml)
        expect(template.kind).toBe('unsupported')
        if (template.kind !== 'unsupported') return
        expect(template.reason).toContain('some-future-field-type')
    })

    it('is unsupported for invalid YAML', () => {
        const template = parseIssueFormYaml('broken.yml', ': : not yaml {{{')
        expect(template.kind).toBe('unsupported')
    })

    it('is unsupported when body is missing or empty', () => {
        expect(parseIssueFormYaml('no-body.yml', 'name: No Body').kind).toBe('unsupported')
        expect(parseIssueFormYaml('empty-body.yml', 'name: Empty\nbody: []').kind).toBe('unsupported')
    })

    it('is unsupported when a non-markdown field is missing a label', () => {
        const missingLabel = parseIssueFormYaml('x.yml', 'body:\n  - type: input\n    id: field\n    attributes: {}')
        expect(missingLabel.kind).toBe('unsupported')
    })

    // GitHub's issue-forms schema makes `id` optional (the field's rendered
    // issue-body section is keyed by label, never id) — a field without one
    // is still a valid, GitHub-accepted form, so it gets a generated id
    // rather than rejecting the whole template (review finding).
    it('generates a stable slug id for a field missing one, instead of rejecting the template', () => {
        const template = parseIssueFormYaml('x.yml', 'body:\n  - type: input\n    attributes:\n      label: Contact Details')
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        expect(template.fields).toEqual([{
            kind: 'input', id: 'contact-details', label: 'Contact Details', description: undefined,
            placeholder: undefined, value: undefined, required: false, minLength: undefined
        }])
    })

    it('resolves a generated-id collision against another field\'s explicit or generated id', () => {
        const yaml = `
body:
  - type: input
    attributes:
      label: Name
  - type: input
    id: name
    attributes:
      label: Something Else
  - type: input
    attributes:
      label: Name
`
        const template = parseIssueFormYaml('x.yml', yaml)
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        const ids = template.fields.map(f => f.kind !== 'markdown' ? f.id : null)
        expect(ids).toEqual(['name-2', 'name', 'name-3'])
        expect(new Set(ids).size).toBe(3)
    })

    it('parses validations.min_length for input/textarea fields', () => {
        const yaml = `
body:
  - type: textarea
    id: repro
    attributes:
      label: Reproduction steps
    validations:
      required: true
      min_length: 100
`
        const template = parseIssueFormYaml('x.yml', yaml)
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        const field = template.fields[0]
        expect(field?.kind === 'textarea' && field.minLength).toBe(100)
    })

    it('is unsupported when a dropdown or checkboxes field has no options', () => {
        const dropdown = parseIssueFormYaml('x.yml', 'body:\n  - type: dropdown\n    id: d\n    attributes:\n      label: D\n      options: []')
        expect(dropdown.kind).toBe('unsupported')
        const checkboxes = parseIssueFormYaml('x.yml', 'body:\n  - type: checkboxes\n    id: c\n    attributes:\n      label: C\n      options: []')
        expect(checkboxes.kind).toBe('unsupported')
    })
})

describe('parseLegacyIssueTemplate', () => {
    it('splits frontmatter from body and supports comma-separated labels/assignees', () => {
        const markdown = `---
name: Feature request
about: Suggest a new feature
title: "[Feature] "
labels: enhancement, needs-triage
assignees: octocat, hubot
---
**Is your feature request related to a problem?**

A clear description.
`
        const template = parseLegacyIssueTemplate('feature_request.md', markdown)
        expect(template.kind).toBe('legacy')
        if (template.kind !== 'legacy') return
        expect(template.name).toBe('Feature request')
        expect(template.description).toBe('Suggest a new feature')
        expect(template.titlePrefix).toBe('[Feature] ')
        expect(template.labels).toEqual(['enhancement', 'needs-triage'])
        expect(template.assignees).toEqual(['octocat', 'hubot'])
        expect(template.body).toContain('Is your feature request related to a problem?')
        expect(template.body).not.toContain('---')
    })

    it('supports a YAML-list form of labels/assignees too', () => {
        const markdown = `---
name: Bug
labels:
  - bug
assignees:
  - octocat
---
Body text.
`
        const template = parseLegacyIssueTemplate('bug.md', markdown)
        if (template.kind !== 'legacy') throw new Error('expected legacy')
        expect(template.labels).toEqual(['bug'])
        expect(template.assignees).toEqual(['octocat'])
    })

    it('treats a file with no frontmatter as a plain body with no metadata', () => {
        const template = parseLegacyIssueTemplate('plain.md', 'Just some text, no frontmatter.')
        if (template.kind !== 'legacy') throw new Error('expected legacy')
        expect(template.name).toBe('plain.md')
        expect(template.body).toBe('Just some text, no frontmatter.')
        expect(template.labels).toEqual([])
    })
})

describe('parseIssueTemplateConfig', () => {
    it('reads blank_issues_enabled: false', () => {
        expect(parseIssueTemplateConfig('blank_issues_enabled: false').blankIssuesEnabled).toBe(false)
    })

    it('defaults to allowed when the key is absent or the file is malformed', () => {
        expect(parseIssueTemplateConfig('contact_links: []').blankIssuesEnabled).toBe(true)
        expect(parseIssueTemplateConfig(': : not yaml {{{').blankIssuesEnabled).toBe(true)
    })
})
