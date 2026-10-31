import { useEffect, useMemo, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select-control'
import { Spinner } from '@/components/Spinner'
import { IssueFormFieldView } from '@/components/IssueFormField'
import { getApiErrorMessage, getApiErrorUrl } from '@/lib/apiErrorMessage'
import { useTranslation } from '@/lib/use-translation'
import {
    formatIssueBody,
    initialAnswersForFields,
    isUsableIssueTemplate,
    type IssueFormAnswer,
    type IssueTemplate,
    type LegacyIssueTemplate,
    type StructuredIssueTemplate
} from '@hapi/protocol/issueTemplates'

const FIELD_INPUT_CLASS = 'w-full px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent'

type Step = 'repo' | 'template' | 'form' | 'review'

/**
 * `null` = "blank issue" selected, distinct from `undefined` = "nothing
 * chosen yet." Never `UnsupportedIssueTemplate` — the picker only ever
 * offers usable templates (isUsableIssueTemplate-filtered) or the blank
 * option, so this is narrower than the full `IssueTemplate` union by
 * construction, not just by convention.
 */
type TemplateSelection = StructuredIssueTemplate | LegacyIssueTemplate | null | undefined

export type NewCardDialogProps = {
    isOpen: boolean
    onClose: () => void
    /** Distinct repos already seen on this board — picker convenience, not a restriction (any repo on the board's host is a free-text option too). */
    knownRepos: string[]
    templates: IssueTemplate[]
    blankAllowed: boolean
    /** GitHub's own issue chooser for this repo — offered as an escape hatch when `blankAllowed` is false and no usable template covers what the user needs. */
    githubNewIssueUrl: string | null
    isLoadingTemplates: boolean
    templatesError: string | null
    onRepoChange: (repo: string | null) => void
    onSubmit: (payload: { repo: string; title: string; body: string; labels: string[]; assignees: string[] }) => Promise<string>
}

/**
 * "Create a card" — goes through the target repo's own
 * `.github/ISSUE_TEMPLATE/` issue-form templates the same way GitHub's own
 * "New issue" UI does (hapi#238 operator decision), not a bare title+body
 * drop. Dialog-owned, blocking flow (same contract as AddBoardDialog), not
 * the always-available fire-and-toast pattern useBoardItemActions uses for
 * existing-item actions — every step is reviewed before the final write
 * against a real repository.
 */
export function NewCardDialog(props: NewCardDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, knownRepos, templates, blankAllowed, githubNewIssueUrl, isLoadingTemplates, templatesError, onRepoChange, onSubmit } = props

    const [step, setStep] = useState<Step>('repo')
    const [repoInput, setRepoInput] = useState('')
    const [customRepo, setCustomRepo] = useState(false)
    const [selectedTemplate, setSelectedTemplate] = useState<TemplateSelection>(undefined)
    const [title, setTitle] = useState('')
    const [freeTextBody, setFreeTextBody] = useState('')
    const [answers, setAnswers] = useState<Record<string, IssueFormAnswer>>({})
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Set only for a partial-failure write — the issue itself was created but
    // adding it to the project then failed. Surfacing its real URL (not just
    // prose that happens to mention it) is the legible version of that state
    // (operator ruling, hapi#238): the user has an orphaned issue to go
    // handle by hand, and a bare "closed dialog" would hide that entirely.
    const [orphanedIssueUrl, setOrphanedIssueUrl] = useState<string | null>(null)

    useEffect(() => {
        if (!isOpen) return
        setStep('repo')
        setRepoInput('')
        setCustomRepo(knownRepos.length === 0)
        setSelectedTemplate(undefined)
        setTitle('')
        setFreeTextBody('')
        setAnswers({})
        setError(null)
        setOrphanedIssueUrl(null)
        setIsSubmitting(false)
    }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

    const usableTemplates = useMemo(() => templates.filter(isUsableIssueTemplate), [templates])
    const unsupportedTemplates = useMemo(() => templates.filter(template => !isUsableIssueTemplate(template)), [templates])
    // The repo's `blank_issues_enabled: false` is honored even when nothing
    // parsed as usable (operator ruling, hapi#238) — that flag is the
    // maintainer's own statement that unstructured issues are unwelcome, and
    // "nothing usable" is often our parser's gap rather than evidence the
    // repo lacks templates. Creation is blocked outright rather than
    // silently falling back to blank; `githubNewIssueUrl` is the escape
    // hatch offered instead of a dead end.
    const isBlocked = !blankAllowed && usableTemplates.length === 0

    const formattedBody = useMemo(() => {
        if (selectedTemplate && selectedTemplate.kind === 'form') {
            return formatIssueBody(selectedTemplate.fields, Object.values(answers))
        }
        return freeTextBody
    }, [selectedTemplate, answers, freeTextBody])

    // GitHub's template `title` is a pre-populated DEFAULT, fully editable —
    // not an unavoidable prefix glued ahead of whatever the user types
    // (review finding). Seeded into `title` itself in handleTemplatePick, so
    // this just trims whatever's actually in the input.
    const finalTitle = title.trim()
    const canSubmitForm = selectedTemplate?.kind !== 'form'
        || selectedTemplate.fields.every(field => {
            if (field.kind === 'markdown') return true
            const answer = answers[field.id]
            if (field.kind === 'checkboxes') {
                const checked = answer && answer.kind === 'checkboxes' ? answer.checked : []
                return field.options.every(option => !option.required || checked.includes(option.label))
            }
            if (field.kind === 'input' || field.kind === 'textarea') {
                const raw = answer && answer.kind === field.kind ? answer.value.trim() : ''
                // GitHub enforces min_length as an HTML `minlength` attribute —
                // it still applies to a non-empty answer on an optional field,
                // just not to one left blank (review finding: a required
                // field's min_length was being silently ignored, only
                // non-emptiness was checked).
                if (!field.required && raw.length === 0) return true
                return raw.length >= (field.minLength ?? (field.required ? 1 : 0))
            }
            if (!field.required) return true
            return answer && answer.kind === 'dropdown' && answer.selected.length > 0
        })

    const handleRepoNext = () => {
        const repo = repoInput.trim()
        if (!repo) return
        onRepoChange(repo)
        setStep('template')
    }

    const handleTemplatePick = (template: TemplateSelection) => {
        setSelectedTemplate(template)
        // Seed answers from the template's own defaults (an input/textarea's
        // `value:`, a single-select dropdown's `defaultIndex:`) so accepting
        // a prefilled field counts as answering it — otherwise the field
        // shows a value on screen that canSubmitForm/formatIssueBody treat
        // as unanswered until the user re-types it (review finding).
        setAnswers(
            template && template.kind === 'form'
                ? Object.fromEntries(initialAnswersForFields(template.fields).map(answer => [answer.id, answer]))
                : {}
        )
        setFreeTextBody(template && template.kind === 'legacy' ? template.body : '')
        // The template's `title` is a pre-populated default the user is free
        // to replace or clear (review finding) — seeded directly into the
        // editable input rather than rendered as an unremovable prefix ahead
        // of it.
        setTitle(template?.titlePrefix ?? '')
        setStep('form')
    }

    const handleSubmit = async () => {
        setError(null)
        setOrphanedIssueUrl(null)
        setIsSubmitting(true)
        try {
            await onSubmit({
                repo: repoInput.trim(),
                title: finalTitle,
                body: formattedBody,
                labels: selectedTemplate?.labels ?? [],
                assignees: selectedTemplate?.assignees ?? []
            })
            onClose()
        } catch (err) {
            setError(getApiErrorMessage(err, t('boards.newCard.error')))
            setOrphanedIssueUrl(getApiErrorUrl(err))
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && !isSubmitting && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('boards.newCard.title')}
                    </DialogTitle>
                </DialogHeader>

                <div className="mt-4 flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
                    {step === 'repo' ? (
                        <div className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-sm font-medium text-[var(--app-fg)]">{t('boards.newCard.repoLabel')}</span>
                                {knownRepos.length > 0 && !customRepo ? (
                                    <SelectControl
                                        value={repoInput}
                                        onChange={(event) => {
                                            if (event.target.value === '__other__') {
                                                setCustomRepo(true)
                                                setRepoInput('')
                                            } else {
                                                setRepoInput(event.target.value)
                                            }
                                        }}
                                        className={`${FIELD_INPUT_CLASS} py-2 pl-3 text-sm`}
                                    >
                                        <option value="">{t('boards.newCard.selectRepo')}</option>
                                        {knownRepos.map((repo) => (
                                            <option key={repo} value={repo}>{repo}</option>
                                        ))}
                                        <option value="__other__">{t('boards.newCard.otherRepo')}</option>
                                    </SelectControl>
                                ) : (
                                    <input
                                        type="text"
                                        value={repoInput}
                                        onChange={(event) => setRepoInput(event.target.value)}
                                        placeholder={t('boards.newCard.repoPlaceholder')}
                                        className={FIELD_INPUT_CLASS}
                                        autoFocus
                                    />
                                )}
                            </label>
                            <div className="flex items-center justify-end gap-2">
                                <Button type="button" variant="secondary" onClick={onClose}>
                                    {t('button.cancel')}
                                </Button>
                                <Button type="button" onClick={handleRepoNext} disabled={!repoInput.trim()}>
                                    {t('button.next')}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {step === 'template' ? (
                        <div className="flex flex-col gap-3">
                            <div className="text-xs text-[var(--app-hint)]">{t('boards.newCard.repoLabel')}: {repoInput}</div>
                            {isLoadingTemplates ? (
                                <div className="flex justify-center p-4"><Spinner size="sm" /></div>
                            ) : templatesError ? (
                                <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                                    {templatesError}
                                </div>
                            ) : isBlocked ? (
                                <div className="flex flex-col gap-3">
                                    <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                                        {t('boards.newCard.blankDisabled')}
                                    </div>
                                    {unsupportedTemplates.length > 0 ? (
                                        <ul className="flex flex-col gap-1.5">
                                            {unsupportedTemplates.map((template) => (
                                                <li key={template.id}>
                                                    <div
                                                        className="flex w-full flex-col gap-0.5 rounded-lg border border-[var(--app-border)] px-3 py-2 opacity-50"
                                                        title={template.reason}
                                                    >
                                                        <span className="text-sm font-medium text-[var(--app-fg)]">{template.name}</span>
                                                        <span className="text-xs text-[var(--app-hint)]">{template.reason}</span>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="text-sm text-[var(--app-hint)]">{t('boards.newCard.noTemplatesFound')}</div>
                                    )}
                                    {githubNewIssueUrl ? (
                                        <a
                                            href={githubNewIssueUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:opacity-90 h-9 px-4 py-2"
                                        >
                                            {t('boards.newCard.openOnGithub')}
                                        </a>
                                    ) : null}
                                </div>
                            ) : (
                                <ul className="flex flex-col gap-1.5">
                                    {usableTemplates.map((template) => (
                                        <li key={template.id}>
                                            <button
                                                type="button"
                                                onClick={() => handleTemplatePick(template)}
                                                className="flex w-full flex-col gap-0.5 rounded-lg border border-[var(--app-border)] px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)]"
                                            >
                                                <span className="text-sm font-medium text-[var(--app-fg)]">{template.name}</span>
                                                {template.description ? (
                                                    <span className="text-xs text-[var(--app-hint)]">{template.description}</span>
                                                ) : null}
                                            </button>
                                        </li>
                                    ))}
                                    {blankAllowed ? (
                                        <li>
                                            <button
                                                type="button"
                                                onClick={() => handleTemplatePick(null)}
                                                className="flex w-full flex-col gap-0.5 rounded-lg border border-dashed border-[var(--app-border)] px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)]"
                                            >
                                                <span className="text-sm font-medium text-[var(--app-fg)]">{t('boards.newCard.blankIssue')}</span>
                                            </button>
                                        </li>
                                    ) : null}
                                    {unsupportedTemplates.map((template) => (
                                        <li key={template.id}>
                                            <div
                                                className="flex w-full flex-col gap-0.5 rounded-lg border border-[var(--app-border)] px-3 py-2 opacity-50"
                                                title={template.reason}
                                            >
                                                <span className="text-sm font-medium text-[var(--app-fg)]">{template.name}</span>
                                                <span className="text-xs text-[var(--app-hint)]">{template.reason}</span>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="flex items-center justify-between gap-2">
                                <Button type="button" variant="secondary" onClick={() => setStep('repo')}>
                                    {t('button.back')}
                                </Button>
                                <Button type="button" variant="secondary" onClick={onClose}>
                                    {t('button.cancel')}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {step === 'form' ? (
                        <div className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-sm font-medium text-[var(--app-fg)]">{t('boards.newCard.titleLabel')}</span>
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(event) => setTitle(event.target.value)}
                                    className={FIELD_INPUT_CLASS}
                                    autoFocus
                                />
                            </label>
                            {selectedTemplate && selectedTemplate.kind === 'form' ? (
                                selectedTemplate.fields.map((field, index) => (
                                    <IssueFormFieldView
                                        key={field.kind === 'markdown' ? `markdown-${index}` : field.id}
                                        field={field}
                                        answer={field.kind === 'markdown' ? undefined : answers[field.id]}
                                        onChange={(answer) => setAnswers(prev => ({ ...prev, [answer.id]: answer }))}
                                    />
                                ))
                            ) : (
                                <label className="flex flex-col gap-1.5">
                                    <span className="text-sm font-medium text-[var(--app-fg)]">{t('boards.newCard.bodyLabel')}</span>
                                    <textarea
                                        rows={6}
                                        value={freeTextBody}
                                        onChange={(event) => setFreeTextBody(event.target.value)}
                                        className={`${FIELD_INPUT_CLASS} resize-y font-mono text-sm`}
                                    />
                                </label>
                            )}
                            <div className="flex items-center justify-between gap-2">
                                <Button type="button" variant="secondary" onClick={() => setStep('template')}>
                                    {t('button.back')}
                                </Button>
                                <Button type="button" onClick={() => setStep('review')} disabled={!title.trim() || !canSubmitForm}>
                                    {t('button.next')}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {step === 'review' ? (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-2 rounded-lg border border-[var(--app-border)] p-3 text-sm">
                                <div><span className="font-medium text-[var(--app-fg)]">{t('boards.newCard.repoLabel')}:</span> <span className="text-[var(--app-hint)]">{repoInput}</span></div>
                                <div><span className="font-medium text-[var(--app-fg)]">{t('boards.newCard.titleLabel')}:</span> <span className="text-[var(--app-hint)]">{finalTitle}</span></div>
                                {selectedTemplate?.labels.length ? (
                                    <div><span className="font-medium text-[var(--app-fg)]">{t('boards.newCard.labels')}:</span> <span className="text-[var(--app-hint)]">{selectedTemplate.labels.join(', ')}</span></div>
                                ) : null}
                                {selectedTemplate?.assignees.length ? (
                                    <div><span className="font-medium text-[var(--app-fg)]">{t('boards.newCard.assignees')}:</span> <span className="text-[var(--app-hint)]">{selectedTemplate.assignees.join(', ')}</span></div>
                                ) : null}
                                <div className="flex flex-col gap-1">
                                    <span className="font-medium text-[var(--app-fg)]">{t('boards.newCard.bodyPreview')}:</span>
                                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--app-subtle-bg)] p-2 font-mono text-xs text-[var(--app-fg)]">
                                        {formattedBody || t('boards.newCard.emptyBody')}
                                    </pre>
                                </div>
                            </div>

                            {error ? (
                                <div className="flex flex-col gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                                    <span>{error}</span>
                                    {orphanedIssueUrl ? (
                                        <a href={orphanedIssueUrl} target="_blank" rel="noreferrer" className="font-medium underline">
                                            {orphanedIssueUrl}
                                        </a>
                                    ) : null}
                                </div>
                            ) : null}

                            <div className="flex items-center justify-between gap-2">
                                <Button type="button" variant="secondary" onClick={() => setStep('form')} disabled={isSubmitting}>
                                    {t('button.back')}
                                </Button>
                                <Button type="button" className="gap-2" aria-busy={isSubmitting} onClick={handleSubmit} disabled={isSubmitting}>
                                    {isSubmitting ? (
                                        <>
                                            <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                            {t('boards.newCard.creating')}
                                        </>
                                    ) : t('boards.newCard.create')}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    )
}
