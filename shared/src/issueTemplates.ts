/**
 * GitHub issue-forms domain (hapi#238 Boards "create a card"). Types +
 * answer-to-markdown formatting live here so the web preview (what the user
 * sees before submitting) and the hub's actual issue-create body (what
 * GitHub really stores) can never drift apart — both call `formatIssueBody`.
 *
 * YAML/frontmatter parsing is deliberately NOT here: it only ever runs
 * hub-side (hub fetches the raw template files; web only ever receives
 * already-parsed JSON over the wire), so it lives in
 * `hub/src/web/routes/issueTemplateParser.ts` instead of pulling a YAML
 * dependency into the web bundle for code the browser never calls.
 *
 * GitHub's own issue-forms rendering has no dedicated "create from
 * template" REST/GraphQL endpoint — it's purely a web-UI convention: parse
 * the YAML, render a form, format answers into markdown, then call the
 * exact same issue-create path any other issue goes through. Replicating
 * "just like GitHub does" means replicating that formatting convention
 * ourselves (operator decision, hapi#238): each non-markdown field renders
 * as `### <label>\n\n<answer>`, in body order, with `_No response_` for an
 * unanswered optional field — confirmed against GitHub's own documented
 * issue-forms behavior.
 */

export type IssueFormMarkdownField = {
    kind: 'markdown'
    value: string
}

export type IssueFormInputField = {
    kind: 'input'
    id: string
    label: string
    description?: string
    placeholder?: string
    value?: string
    required: boolean
    /** `validations.min_length` — GitHub enforces this as an HTML `minlength`, so it still applies to a non-empty optional answer, just not to a blank one. */
    minLength?: number
}

export type IssueFormTextareaField = {
    kind: 'textarea'
    id: string
    label: string
    description?: string
    placeholder?: string
    value?: string
    /** Optional code-fence language (`attributes.render` in the YAML) — e.g. `shell`. */
    render?: string
    required: boolean
    /** `validations.min_length` — GitHub enforces this as an HTML `minlength`, so it still applies to a non-empty optional answer, just not to a blank one. */
    minLength?: number
}

export type IssueFormDropdownField = {
    kind: 'dropdown'
    id: string
    label: string
    description?: string
    options: string[]
    multiple: boolean
    /** Index into `options` pre-selected by the template, single-select only. */
    defaultIndex?: number
    required: boolean
}

export type IssueFormCheckboxOption = {
    label: string
    required: boolean
}

export type IssueFormCheckboxesField = {
    kind: 'checkboxes'
    id: string
    label: string
    description?: string
    options: IssueFormCheckboxOption[]
}

export type IssueFormField =
    | IssueFormMarkdownField
    | IssueFormInputField
    | IssueFormTextareaField
    | IssueFormDropdownField
    | IssueFormCheckboxesField

/** The user's answer to one non-markdown field, keyed by the field's `id`. */
export type IssueFormAnswer =
    | { kind: 'input'; id: string; value: string }
    | { kind: 'textarea'; id: string; value: string }
    | { kind: 'dropdown'; id: string; selected: string[] }
    | { kind: 'checkboxes'; id: string; checked: string[] }

export type IssueTemplateBase = {
    /** The template's filename — stable identity within a repo, unique per fetch. */
    id: string
    name: string
    description?: string
    /** `title:` in the YAML / frontmatter — prefixed onto the user's own title. */
    titlePrefix?: string
    labels: string[]
    assignees: string[]
}

/** A `.yml`/`.yaml` issue form — structured fields, rendered as a dynamic form. */
export type StructuredIssueTemplate = IssueTemplateBase & {
    kind: 'form'
    fields: IssueFormField[]
}

/** A legacy `.md` template (YAML frontmatter + free-text body) — no structured fields. */
export type LegacyIssueTemplate = IssueTemplateBase & {
    kind: 'legacy'
    /** Frontmatter-stripped body, used to pre-fill a single free-text textarea. */
    body: string
}

/**
 * A template whose body uses a form feature this UI doesn't render (operator
 * decision, hapi#238: fails loudly — the whole template is excluded from the
 * picker with `reason` shown, never rendered with one field silently
 * dropped). Carries only enough identity to list-and-explain, not create.
 */
export type UnsupportedIssueTemplate = {
    id: string
    name: string
    kind: 'unsupported'
    reason: string
}

export type IssueTemplate = StructuredIssueTemplate | LegacyIssueTemplate | UnsupportedIssueTemplate

export function isUsableIssueTemplate(
    template: IssueTemplate
): template is StructuredIssueTemplate | LegacyIssueTemplate {
    return template.kind !== 'unsupported'
}

/**
 * The answers a field's own template-declared defaults already represent
 * before the user has touched anything — an input/textarea's `value:` and a
 * single-select dropdown's `defaultIndex:` (review finding). Without this,
 * `IssueFormFieldView` shows the prefilled value on screen, but it's
 * invisible to both the dialog's required-field check and `formatIssueBody`
 * below ("_No response_") until the user explicitly edits that field —
 * accepting a sensible default should count as answering it. Checkboxes
 * have no analogous "pre-checked" concept in the issue-forms schema, so
 * there's nothing to seed for that kind.
 */
export function initialAnswersForFields(fields: IssueFormField[]): IssueFormAnswer[] {
    const answers: IssueFormAnswer[] = []
    for (const field of fields) {
        if ((field.kind === 'input' || field.kind === 'textarea') && field.value) {
            answers.push({ kind: field.kind, id: field.id, value: field.value })
        } else if (field.kind === 'dropdown' && !field.multiple && field.defaultIndex !== undefined) {
            const option = field.options[field.defaultIndex]
            if (option !== undefined) {
                answers.push({ kind: 'dropdown', id: field.id, selected: [option] })
            }
        }
    }
    return answers
}

/**
 * Formats a structured template's answers into the markdown body GitHub's
 * own issue-forms UI would produce. `markdown`-kind fields are instructional
 * only (no answer) and are skipped, matching GitHub's own behavior.
 */
export function formatIssueBody(fields: IssueFormField[], answers: IssueFormAnswer[]): string {
    const answerById = new Map(answers.map(answer => [answer.id, answer]))
    const sections: string[] = []

    for (const field of fields) {
        if (field.kind === 'markdown') continue

        const answer = answerById.get(field.id)
        let valueText: string

        if (field.kind === 'input' || field.kind === 'textarea') {
            const raw = answer && answer.kind === field.kind ? answer.value.trim() : ''
            if (!raw) {
                valueText = '_No response_'
            } else if (field.kind === 'textarea' && field.render) {
                valueText = `\`\`\`${field.render}\n${raw}\n\`\`\``
            } else {
                valueText = raw
            }
        } else if (field.kind === 'dropdown') {
            const selected = answer && answer.kind === 'dropdown' ? answer.selected : []
            valueText = selected.length > 0 ? selected.join(', ') : '_No response_'
        } else {
            const checked = answer && answer.kind === 'checkboxes' ? new Set(answer.checked) : new Set<string>()
            valueText = field.options.map(option => `- [${checked.has(option.label) ? 'x' : ' '}] ${option.label}`).join('\n')
        }

        sections.push(`### ${field.label}\n\n${valueText}`)
    }

    return sections.join('\n\n')
}
