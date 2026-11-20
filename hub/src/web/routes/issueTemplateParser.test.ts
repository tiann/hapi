import { describe, expect, it } from 'bun:test'
import { hasRequiredLegacyTemplateFrontmatter, parseIssueFormYaml, parseIssueTemplateConfig, parseLegacyIssueTemplate } from './issueTemplateParser'

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
            required: false,
            options: [{ label: 'I agree to follow this project\'s Code of Conduct', required: true }]
        })
    })

    // Review finding (tiann/hapi#2147, follow-up): GitHub's own form
    // schema documents a GROUP-level `validations.required` for
    // checkboxes, distinct from any individual option's own `required` —
    // the parser was only ever capturing the per-option one.
    it('captures validations.required on the checkbox group itself, distinct from per-option required', () => {
        const yaml = `
name: Bug report
description: File a bug report
body:
  - type: checkboxes
    id: terms
    attributes:
      label: Code of Conduct
      options:
        - label: Just an optional note
    validations:
      required: true
`
        const template = parseIssueFormYaml('bug_report.yml', yaml)
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        expect(template.fields[0]).toMatchObject({
            kind: 'checkboxes',
            required: true,
            options: [{ label: 'Just an optional note', required: false }]
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
description: File a bug report
labels: bug, needs-triage
assignees: octocat
body:
  - type: markdown
    attributes:
      value: Thanks!
  - type: input
    attributes:
      label: Contact Details
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
description: A form with an unsupported field
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

    it('marks the whole template unsupported for a top-level type declaration, not silently dropped', () => {
        const yaml = `
name: Bug report
description: File a bug report
type: Bug
body:
  - type: input
    id: contact
    attributes:
      label: Contact Details
`
        const template = parseIssueFormYaml('typed.yml', yaml)
        expect(template.kind).toBe('unsupported')
        if (template.kind !== 'unsupported') return
        expect(template.reason).toContain('type')
    })

    it('marks the whole template unsupported for a top-level projects declaration, not silently dropped', () => {
        const yaml = `
name: Bug report
description: File a bug report
projects: ["acme/2"]
body:
  - type: input
    id: contact
    attributes:
      label: Contact Details
`
        const template = parseIssueFormYaml('projected.yml', yaml)
        expect(template.kind).toBe('unsupported')
        if (template.kind !== 'unsupported') return
        expect(template.reason).toContain('projects')
    })

    it('is unsupported for invalid YAML', () => {
        const template = parseIssueFormYaml('broken.yml', ': : not yaml {{{')
        expect(template.kind).toBe('unsupported')
    })

    it('is unsupported when body is missing or empty', () => {
        expect(parseIssueFormYaml('no-body.yml', 'name: No Body\ndescription: No Body').kind).toBe('unsupported')
        expect(parseIssueFormYaml('empty-body.yml', 'name: Empty\ndescription: Empty\nbody: []').kind).toBe('unsupported')
    })

    it('is unsupported when a non-markdown field is missing a label', () => {
        const missingLabel = parseIssueFormYaml('x.yml', 'name: Bug\ndescription: Bug\nbody:\n  - type: input\n    id: field\n    attributes: {}')
        expect(missingLabel.kind).toBe('unsupported')
    })

    // GitHub's issue-forms schema makes `id` optional (the field's rendered
    // issue-body section is keyed by label, never id) — a field without one
    // is still a valid, GitHub-accepted form, so it gets a generated id
    // rather than rejecting the whole template (review finding).
    it('generates a stable slug id for a field missing one, instead of rejecting the template', () => {
        const template = parseIssueFormYaml('x.yml', 'name: Bug\ndescription: Bug\nbody:\n  - type: input\n    attributes:\n      label: Contact Details')
        expect(template.kind).toBe('form')
        if (template.kind !== 'form') return
        expect(template.fields).toEqual([{
            kind: 'input', id: 'contact-details', label: 'Contact Details', description: undefined,
            placeholder: undefined, value: undefined, required: false, minLength: undefined
        }])
    })

    it('resolves a generated-id collision against another field\'s explicit or generated id', () => {
        const yaml = `
name: Bug
description: Bug
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
name: Bug
description: Bug
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
        const dropdown = parseIssueFormYaml('x.yml', 'name: Bug\ndescription: Bug\nbody:\n  - type: dropdown\n    id: d\n    attributes:\n      label: D\n      options: []')
        expect(dropdown.kind).toBe('unsupported')
        const checkboxes = parseIssueFormYaml('x.yml', 'name: Bug\ndescription: Bug\nbody:\n  - type: checkboxes\n    id: c\n    attributes:\n      label: C\n      options: []')
        expect(checkboxes.kind).toBe('unsupported')
    })

    // Review finding (tiann/hapi#2147): GitHub requires `name` on an issue
    // form — a file missing it used to fall back to the filename and be
    // accepted as usable, even though GitHub's own chooser would never
    // have offered it, letting it wrongly suppress .github inheritance.
    it('is unsupported when name is missing, rather than falling back to the filename', () => {
        const template = parseIssueFormYaml('x.yml', 'body:\n  - type: markdown\n    attributes:\n      value: Hi')
        expect(template.kind).toBe('unsupported')
        expect(template.kind === 'unsupported' && template.githubValid).toBe(false)
    })

    // Review finding (tiann/hapi#2147): `description` is required alongside
    // `name` per GitHub's own top-level syntax table — a form missing it
    // used to be accepted as usable anyway.
    it('is unsupported when description is missing', () => {
        const template = parseIssueFormYaml('x.yml', 'name: Bug\nbody:\n  - type: input\n    attributes:\n      label: Contact')
        expect(template.kind).toBe('unsupported')
        expect(template.kind === 'unsupported' && template.githubValid).toBe(false)
    })

    // Review finding (tiann/hapi#2147): GitHub's own docs document "Body
    // must contain at least one non-markdown field" as a validation error —
    // markdown elements are static text, never submitted, so a body made
    // of only markdown collects no input at all.
    it('is unsupported when the body contains only markdown elements', () => {
        const template = parseIssueFormYaml('x.yml', 'name: Bug\ndescription: Bug\nbody:\n  - type: markdown\n    attributes:\n      value: Hi\n  - type: markdown\n    attributes:\n      value: There')
        expect(template.kind).toBe('unsupported')
        expect(template.kind === 'unsupported' && template.githubValid).toBe(false)
    })

    // Review finding (tiann/hapi#2147, follow-up): `upload` is a real,
    // GitHub-recognized field type — unlike a genuinely malformed or
    // unrecognized one, GitHub's own chooser still offers a form that
    // uses it, so it must count as githubValid: true for .github
    // inheritance-coverage purposes, even though Boards itself can't
    // render a file picker and still excludes the template from filing.
    it('is unsupported but githubValid when the body uses an upload field', () => {
        const template = parseIssueFormYaml(
            'x.yml',
            'name: Bug\ndescription: Bug\nbody:\n  - type: upload\n    id: screenshots\n    attributes:\n      label: Screenshots'
        )
        expect(template.kind).toBe('unsupported')
        expect(template.kind === 'unsupported' && template.githubValid).toBe(true)
    })

    // Regression (bot review, tiann/hapi#2147, follow-up): an upload field
    // still has to satisfy the same "every non-markdown field needs a
    // label" baseline every other field type is held to — a label-less
    // one is genuinely malformed, not a form GitHub's own chooser would
    // ever offer, so it must not get the upload type's githubValid: true
    // treatment.
    it('is genuinely invalid (githubValid: false), not merely unsupported, when an upload field has no label', () => {
        const template = parseIssueFormYaml(
            'x.yml',
            'name: Bug\ndescription: Bug\nbody:\n  - type: upload\n    id: screenshots\n    attributes: {}'
        )
        expect(template.kind).toBe('unsupported')
        expect(template.kind === 'unsupported' && template.githubValid).toBe(false)
    })

    // Regression (bot review, tiann/hapi#2147, follow-up): the upload
    // field used to return githubValid: true immediately, before the
    // parser ever reached a later field in the same body — so a
    // genuinely malformed field AFTER a well-formed upload field was
    // never caught, and the template wrongly counted as local .github
    // inheritance coverage despite being something GitHub's own chooser
    // would reject outright.
    it('is genuinely invalid, not githubValid, when a well-formed upload field is followed by a malformed one', () => {
        const template = parseIssueFormYaml(
            'x.yml',
            'name: Bug\ndescription: Bug\nbody:\n  - type: upload\n    id: screenshots\n    attributes:\n      label: Screenshots\n  - type: input\n    id: contact\n    attributes: {}'
        )
        expect(template.kind).toBe('unsupported')
        if (template.kind !== 'unsupported') return
        expect(template.githubValid).toBe(false)
        expect(template.reason).toContain('label')
    })

    // Same bug, top-level variant (bot review, tiann/hapi#2147,
    // follow-up): the top-level type:/projects: branches had the same
    // early-return shape as the field-level upload case above.
    it('is genuinely invalid, not githubValid, when a top-level type: is followed by a malformed field', () => {
        const yaml = `
name: Bug report
description: File a bug report
type: Bug
body:
  - type: input
    id: contact
    attributes: {}
`
        const template = parseIssueFormYaml('typed-then-broken.yml', yaml)
        expect(template.kind).toBe('unsupported')
        if (template.kind !== 'unsupported') return
        expect(template.githubValid).toBe(false)
        expect(template.reason).toContain('label')
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

    // Regression (bot review, hapi#238): a declared `type:` used to be
    // silently dropped, filing an untyped issue despite the template's own
    // frontmatter. Mirrors the YAML form path's existing "fail loudly"
    // handling of the same unsupported feature.
    it('marks a template declaring an issue type as unsupported instead of silently dropping it', () => {
        const markdown = `---
name: Bug
type: Bug
---
Body text.
`
        const template = parseLegacyIssueTemplate('bug.md', markdown)
        expect(template.kind).toBe('unsupported')
        if (template.kind !== 'unsupported') return
        expect(template.reason).toContain('type')
    })
})

describe('hasRequiredLegacyTemplateFrontmatter', () => {
    it('accepts frontmatter with a name, even without about — about is a real-world convention, not a confirmed GitHub requirement', () => {
        expect(hasRequiredLegacyTemplateFrontmatter('---\nname: Bug\n---\nBody text')).toBe(true)
    })

    it('rejects a file with no frontmatter at all', () => {
        expect(hasRequiredLegacyTemplateFrontmatter('Just some ordinary notes, no frontmatter at all.')).toBe(false)
    })

    it('rejects frontmatter missing name', () => {
        expect(hasRequiredLegacyTemplateFrontmatter('---\nabout: Suggest a new feature\n---\nBody text')).toBe(false)
    })

    it('rejects malformed frontmatter', () => {
        expect(hasRequiredLegacyTemplateFrontmatter('---\n: : not yaml {{{\n---\nBody text')).toBe(false)
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

    // valid distinguishes "parsed, nothing relevant in it" from "did not
    // parse at all" (review finding, tiann/hapi#2147, follow-up) — the
    // fail-open blankIssuesEnabled default is right either way, but only
    // the former is a real local override for inheritance-eligibility purposes.
    it('reports valid: false only for a genuine parse failure, not an absent key', () => {
        expect(parseIssueTemplateConfig('contact_links: []').valid).toBe(true)
        expect(parseIssueTemplateConfig(': : not yaml {{{').valid).toBe(false)
    })

    // A scalar or sequence parses without throwing, so the try/catch alone
    // isn't enough (review finding, tiann/hapi#2147, follow-up) — asRecord
    // silently coerces either into {}, which would otherwise read as "an
    // empty-but-valid config."
    it('reports valid: false for a syntactically valid scalar or sequence, not just a parse failure', () => {
        expect(parseIssueTemplateConfig('true').valid).toBe(false)
        expect(parseIssueTemplateConfig('- a\n- b\n').valid).toBe(false)
    })
})

// Regression (bot review, hapi#238, follow-up): templateId alone only
// proves a template still exists, not that its content hasn't changed.
describe('template revision', () => {
    it('stays stable for identical content and changes when the form content changes', () => {
        const yaml = 'name: Bug\ndescription: Bug\nbody:\n  - type: input\n    attributes:\n      label: Hi\n'
        const editedYaml = 'name: Bug\ndescription: Bug\nbody:\n  - type: input\n    attributes:\n      label: Hi (edited)\n'
        const first = parseIssueFormYaml('bug.yml', yaml)
        const same = parseIssueFormYaml('bug.yml', yaml)
        const edited = parseIssueFormYaml('bug.yml', editedYaml)
        if (first.kind !== 'form' || same.kind !== 'form' || edited.kind !== 'form') throw new Error('expected form')
        expect(same.revision).toBe(first.revision)
        expect(edited.revision).not.toBe(first.revision)
    })

    it('stays stable for identical content and changes when the legacy template content changes', () => {
        const markdown = '---\nname: Bug\n---\nOriginal body.\n'
        const edited = '---\nname: Bug\n---\nEdited body.\n'
        const first = parseLegacyIssueTemplate('bug.md', markdown)
        const same = parseLegacyIssueTemplate('bug.md', markdown)
        const changed = parseLegacyIssueTemplate('bug.md', edited)
        if (first.kind !== 'legacy' || same.kind !== 'legacy' || changed.kind !== 'legacy') throw new Error('expected legacy')
        expect(same.revision).toBe(first.revision)
        expect(changed.revision).not.toBe(first.revision)
    })
})
