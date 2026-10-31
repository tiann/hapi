import type { IssueFormAnswer, IssueFormField as IssueFormFieldType } from '@/types/api'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'

const FIELD_INPUT_CLASS = 'w-full px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent'

/**
 * Renders one GitHub issue-form body element from its normalized
 * `IssueFormField` descriptor (shared/src/issueTemplates.ts) — same
 * if/else-by-`kind` convention `NewSession/PermissionField.tsx` already
 * uses for `AgentConfigDescriptorSchema` fields, the closest existing
 * precedent for runtime schema-driven form rendering in this codebase.
 *
 * `markdown` fields are display-only instructions (no `onChange` call ever
 * fires for them) — GitHub's own issue-forms UI renders them the same way:
 * present to the fill-in operator, absent from the submitted answer set.
 */
export function IssueFormFieldView(props: {
    field: IssueFormFieldType
    answer: IssueFormAnswer | undefined
    onChange: (answer: IssueFormAnswer) => void
}) {
    const { t } = useTranslation()
    const { field, answer, onChange } = props

    if (field.kind === 'markdown') {
        return (
            <div className="rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                <MarkdownRenderer content={field.value} standalone />
            </div>
        )
    }

    // Checkboxes fields have no group-level `required` — each option carries
    // its own (rendered inline per-option below), unlike the other kinds.
    const isRequired = 'required' in field && field.required
    // `htmlFor`/`id` only make sense where the label maps to exactly one
    // control (input/textarea/single-select) — the checkboxes and
    // multi-select cases already associate each option's own label directly
    // with its own checkbox below, so this top label is more of a group
    // heading for those and is rendered without htmlFor there (review
    // finding, hapi#2147: the label was a bare sibling with no htmlFor/id or
    // aria-labelledby, so a field without a placeholder had no accessible
    // name and clicking the label text didn't focus its control).
    const controlId = field.kind === 'input' || field.kind === 'textarea' || (field.kind === 'dropdown' && !field.multiple)
        ? field.id
        : undefined
    const label = (
        <label className="flex flex-col gap-0.5" htmlFor={controlId}>
            <span className="text-sm font-medium text-[var(--app-fg)]">
                {field.label}
                {isRequired ? <span className="ml-1 text-red-500">*</span> : null}
            </span>
            {field.description ? (
                <span className="text-xs text-[var(--app-hint)]">{field.description}</span>
            ) : null}
            {(field.kind === 'input' || field.kind === 'textarea') && field.minLength ? (
                <span className="text-xs text-[var(--app-hint)]">{t('boards.newCard.minLength', { count: field.minLength })}</span>
            ) : null}
        </label>
    )

    if (field.kind === 'input') {
        const value = answer && answer.kind === 'input' ? answer.value : (field.value ?? '')
        return (
            <div className="flex flex-col gap-1.5">
                {label}
                <input
                    id={field.id}
                    type="text"
                    value={value}
                    placeholder={field.placeholder}
                    // Native `minlength` is purely advisory here (browsers only
                    // enforce it on a real <form> submit, which this isn't) —
                    // `canSubmitForm` is the actual gate; this just gives
                    // autofill/accessibility tools the same signal GitHub's own
                    // rendered form would.
                    minLength={field.minLength}
                    onChange={(event) => onChange({ kind: 'input', id: field.id, value: event.target.value })}
                    className={FIELD_INPUT_CLASS}
                />
            </div>
        )
    }

    if (field.kind === 'textarea') {
        const value = answer && answer.kind === 'textarea' ? answer.value : (field.value ?? '')
        return (
            <div className="flex flex-col gap-1.5">
                {label}
                <textarea
                    id={field.id}
                    rows={5}
                    value={value}
                    placeholder={field.placeholder}
                    minLength={field.minLength}
                    onChange={(event) => onChange({ kind: 'textarea', id: field.id, value: event.target.value })}
                    className={`${FIELD_INPUT_CLASS} resize-y font-mono text-sm`}
                />
            </div>
        )
    }

    if (field.kind === 'dropdown') {
        const selected = answer && answer.kind === 'dropdown' ? answer.selected : []
        if (field.multiple) {
            return (
                <div className="flex flex-col gap-1.5">
                    {label}
                    <div className="flex flex-col gap-1 rounded-lg border border-[var(--app-border)] p-2">
                        {field.options.map((option) => {
                            const checked = selected.includes(option)
                            return (
                                <label key={option} className="flex items-center gap-2 text-sm text-[var(--app-fg)]">
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => onChange({
                                            kind: 'dropdown',
                                            id: field.id,
                                            selected: checked ? selected.filter(o => o !== option) : [...selected, option]
                                        })}
                                    />
                                    {option}
                                </label>
                            )
                        })}
                    </div>
                </div>
            )
        }
        // An explicit answer (even `selected: []` from picking the empty
        // option) is authoritative once it exists — falling back to the
        // template default whenever selected[0] is empty would redisplay a
        // default the user just explicitly cleared, while canSubmitForm and
        // formatIssueBody both still (correctly) treat the clear as empty,
        // so the field would show a selection it does not actually have
        // (review finding).
        const value = answer && answer.kind === 'dropdown'
            ? (selected[0] ?? '')
            : (field.defaultIndex !== undefined ? field.options[field.defaultIndex] : undefined) ?? ''
        return (
            <div className="flex flex-col gap-1.5">
                {label}
                <SelectControl
                    id={field.id}
                    value={value}
                    onChange={(event) => onChange({ kind: 'dropdown', id: field.id, selected: event.target.value ? [event.target.value] : [] })}
                    className={`${FIELD_INPUT_CLASS} py-2 pl-3 text-sm`}
                >
                    <option value="">{t('boards.newCard.selectOption')}</option>
                    {field.options.map((option) => (
                        <option key={option} value={option}>{option}</option>
                    ))}
                </SelectControl>
            </div>
        )
    }

    // checkboxes
    const checked = answer && answer.kind === 'checkboxes' ? answer.checked : []
    return (
        <div className="flex flex-col gap-1.5">
            {label}
            <div className="flex flex-col gap-1 rounded-lg border border-[var(--app-border)] p-2">
                {field.options.map((option) => {
                    const isChecked = checked.includes(option.label)
                    return (
                        <label key={option.label} className="flex items-center gap-2 text-sm text-[var(--app-fg)]">
                            <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => onChange({
                                    kind: 'checkboxes',
                                    id: field.id,
                                    checked: isChecked ? checked.filter(o => o !== option.label) : [...checked, option.label]
                                })}
                            />
                            {option.label}{option.required ? <span className="ml-1 text-red-500">*</span> : null}
                        </label>
                    )
                })}
            </div>
        </div>
    )
}
