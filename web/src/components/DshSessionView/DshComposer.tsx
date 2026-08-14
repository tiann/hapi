import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'

export function DshComposer({ api, sessionId, text, onTextChange, modelLabel }: {
    api: ApiClient | null
    sessionId: string
    text: string
    onTextChange: (text: string) => void
    modelLabel?: string
}) {
    const { t } = useTranslation()
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const sendMessage = useSendMessage(api, sessionId)

    const submit = () => {
        const trimmed = text.trim()
        if (!trimmed || sending) return
        setSending(true)
        setError(null)
        void sendMessage.sendMessage(trimmed, undefined, null, 'queue')
            .then(() => {
                onTextChange('')
                setSending(false)
            })
            .catch((e: unknown) => {
                setSending(false)
                setError(e instanceof Error ? e.message : String(e))
            })
    }

    return (
        <div className="border-t border-[var(--app-border)] px-4 py-3">
            <div className="flex items-end gap-2">
                <textarea
                    value={text}
                    onChange={(e) => onTextChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            submit()
                        }
                    }}
                    placeholder={modelLabel ? `${t('dsh.composerPlaceholder')} · ${modelLabel}` : t('dsh.composerPlaceholder')}
                    rows={Math.min(6, Math.max(1, text.split('\n').length))}
                    className="flex-1 resize-none rounded-lg border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--app-accent)]"
                />
                <button
                    type="button"
                    disabled={sending || text.trim().length === 0}
                    onClick={submit}
                    className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
                >
                    {sending ? t('dsh.sending') : t('dsh.send')}
                </button>
            </div>
            {error ? <div className="mt-1 text-xs text-red-500">{error}</div> : null}
        </div>
    )
}
