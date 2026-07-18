import { useEffect, useState } from 'react'
import type { ComposerSnippetSlot } from '@/lib/composer-snippets'
import type { RecentUserMessage } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    return normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized
}

export function SnippetPicker(props: {
    snippets: ComposerSnippetSlot[]
    recentMessages: RecentUserMessage[]
    recentLoading?: boolean
    recentError?: string | null
    onSelect: (text: string) => void
    onSaveSnippet: (index: number, text: string) => void
    onDeleteSnippet: (index: number) => void
}) {
    const { t } = useTranslation()
    const [editingIndex, setEditingIndex] = useState<number | null>(null)
    const [draft, setDraft] = useState('')

    useEffect(() => {
        if (editingIndex === null) return
        setDraft(props.snippets[editingIndex]?.text ?? '')
    }, [editingIndex, props.snippets])

    const startEdit = (index: number) => {
        setEditingIndex(index)
        setDraft(props.snippets[index]?.text ?? '')
    }

    const save = () => {
        if (editingIndex === null) return
        props.onSaveSnippet(editingIndex, draft)
        setEditingIndex(null)
        setDraft('')
    }

    return (
        <div className="py-2 text-sm text-[var(--app-fg)]">
            <section>
                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                    {t('composer.snippets.saved')}
                </div>
                <div className="space-y-1 px-2">
                    {props.snippets.map((snippet, index) => (
                        <div key={`snippet-${index}`} className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)]/30 p-2">
                            {editingIndex === index ? (
                                <div className="space-y-2">
                                    <textarea
                                        value={draft}
                                        rows={3}
                                        maxLength={4000}
                                        className="w-full resize-y rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                                        placeholder={t('composer.snippets.placeholder')}
                                        onChange={(event) => setDraft(event.target.value)}
                                    />
                                    <div className="flex justify-end gap-2">
                                        <button
                                            type="button"
                                            className="rounded-md px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                                            onClick={() => setEditingIndex(null)}
                                        >
                                            {t('button.cancel')}
                                        </button>
                                        <button
                                            type="button"
                                            className="rounded-md bg-[var(--app-link)] px-2 py-1 text-xs text-white disabled:opacity-50"
                                            onClick={save}
                                        >
                                            {t('button.save')}
                                        </button>
                                    </div>
                                </div>
                            ) : snippet ? (
                                <div className="flex items-start gap-2">
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 text-left leading-snug hover:text-[var(--app-link)]"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => props.onSelect(snippet.text)}
                                    >
                                        <span className="line-clamp-3 break-words">{previewText(snippet.text)}</span>
                                    </button>
                                    <div className="flex shrink-0 gap-1">
                                        <button
                                            type="button"
                                            className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                                            onClick={() => startEdit(index)}
                                        >
                                            {t('composer.snippets.edit')}
                                        </button>
                                        <button
                                            type="button"
                                            className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-red-500"
                                            onClick={() => props.onDeleteSnippet(index)}
                                        >
                                            {t('composer.snippets.delete')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                                    onClick={() => startEdit(index)}
                                >
                                    <span>{t('composer.snippets.emptySlot', { index: index + 1 })}</span>
                                    <span className="text-xs">{t('composer.snippets.add')}</span>
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </section>

            <div className="mx-3 my-2 h-px bg-[var(--app-divider)]" />

            <section>
                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                    {t('composer.snippets.recent')}
                </div>
                <div className="space-y-1 px-2">
                    {props.recentLoading ? (
                        <div className="px-2 py-3 text-sm text-[var(--app-hint)]">{t('composer.snippets.loading')}</div>
                    ) : props.recentError ? (
                        <div className="px-2 py-3 text-sm text-red-500">{props.recentError}</div>
                    ) : props.recentMessages.length === 0 ? (
                        <div className="px-2 py-3 text-sm text-[var(--app-hint)]">{t('composer.snippets.noRecent')}</div>
                    ) : props.recentMessages.map((message) => (
                        <button
                            key={message.id}
                            type="button"
                            className="w-full rounded-lg px-3 py-2 text-left leading-snug hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)]"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => props.onSelect(message.text)}
                        >
                            <span className="line-clamp-3 break-words">{previewText(message.text)}</span>
                        </button>
                    ))}
                </div>
            </section>
        </div>
    )
}
