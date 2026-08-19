import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useTranslation } from '@/lib/use-translation'
import { LoadingState } from '@/components/LoadingState'
import type { StudioPost } from '@/types/api'

function SuggestionRow(props: {
    post: StudioPost
    disabled: boolean
    onSubmit: (text: string) => void
    onDismiss: () => void
}) {
    const { t } = useTranslation()
    const [text, setText] = useState(props.post.text)
    return (
        <div className="border-b border-[var(--app-border)] px-3 py-3 last:border-b-0">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--app-fg)]">{props.post.authorName}</div>
                    <div className="text-xs text-[var(--app-hint)]">{new Date(props.post.createdAt).toLocaleString()}</div>
                </div>
                <span className="shrink-0 text-xs text-[var(--app-hint)]">{t(`studio.post.status.${props.post.status}`)}</span>
            </div>
            {props.post.status === 'open' ? (
                <>
                    <textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        maxLength={4000}
                        rows={3}
                        className="mt-2 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                        <button
                            type="button"
                            disabled={props.disabled}
                            onClick={props.onDismiss}
                            className="rounded-md px-3 py-1.5 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                        >
                            {t('studio.owner.dismiss')}
                        </button>
                        <button
                            type="button"
                            disabled={props.disabled || !text.trim()}
                            onClick={() => props.onSubmit(text.trim())}
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)] disabled:opacity-50"
                        >
                            {t('studio.owner.sendToAgent')}
                        </button>
                    </div>
                </>
            ) : (
                <div className="mt-2 whitespace-pre-wrap text-sm text-[var(--app-fg)]">
                    {props.post.submittedText ?? props.post.text}
                </div>
            )}
        </div>
    )
}

export default function StudioOwnerPage() {
    const { studioId } = useParams({ from: '/studios/$studioId' })
    return <StudioOwnerRoom key={studioId} studioId={studioId} />
}

function StudioOwnerRoom(props: { studioId: string }) {
    const { studioId } = props
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const [copied, setCopied] = useState(false)

    const query = useQuery({
        queryKey: queryKeys.studio(studioId),
        queryFn: () => api.getStudio(studioId),
        refetchInterval: 2_000
    })
    const room = query.data?.room
    const posts = query.data?.posts ?? []
    const suggestions = useMemo(
        () => posts.filter((post) => post.roomId === room?.id && post.kind === 'suggestion'),
        [posts, room?.id]
    )
    const discussions = useMemo(
        () => posts.filter((post) => post.roomId === room?.id && post.kind === 'discussion'),
        [posts, room?.id]
    )
    const shareUrl = room ? `${window.location.origin}/studio/${room.shareToken}` : ''

    const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.studio(studioId) })
    const updateMutation = useMutation({
        mutationFn: (input: { accessMode?: 'view' | 'contribute'; rotateToken?: boolean }) => api.updateStudio(studioId, input),
        onSuccess: refresh
    })
    const decisionMutation = useMutation({
        mutationFn: (input: { postId: string; action: 'submit' | 'dismiss'; text?: string }) =>
            api.decideStudioPost(studioId, input.postId, input),
        onSuccess: refresh
    })
    const revokeMutation = useMutation({
        mutationFn: () => api.revokeStudio(studioId),
        onSuccess: () => navigate({ to: '/sessions/$sessionId', params: { sessionId: room!.sessionId } })
    })

    if (query.isLoading) {
        return <div className="flex h-full items-center justify-center"><LoadingState label={t('studio.loading')} /></div>
    }
    if (!room || query.isError) {
        return <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--app-hint)]">{t('studio.notFound')}</div>
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="border-b border-[var(--app-border)] px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <div className="mx-auto flex max-w-content items-center gap-3">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: room.sessionId } })}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-xl text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                        aria-label={t('studio.back')}
                    >
                        ←
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate text-base font-semibold text-[var(--app-fg)]">{room.title}</h1>
                        <div className="text-xs text-[var(--app-hint)]">{t('studio.owner.title')}</div>
                    </div>
                    <span className={`h-2.5 w-2.5 rounded-full ${room.status === 'active' ? 'bg-green-500' : 'bg-[var(--app-hint)]'}`} />
                </div>
            </header>

            <main className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto max-w-content space-y-5 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                    <section>
                        <h2 className="mb-2 text-xs font-semibold uppercase text-[var(--app-hint)]">{t('studio.owner.shareLink')}</h2>
                        <div className="flex gap-2">
                            <input
                                readOnly
                                value={shareUrl}
                                className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                            />
                            <button
                                type="button"
                                onClick={async () => {
                                    await safeCopyToClipboard(shareUrl)
                                    setCopied(true)
                                    window.setTimeout(() => setCopied(false), 1500)
                                }}
                                className="rounded-md bg-[var(--app-button)] px-3 py-2 text-sm text-[var(--app-button-text)]"
                            >
                                {copied ? t('studio.owner.copied') : t('studio.owner.copy')}
                            </button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <div className="inline-flex overflow-hidden rounded-md border border-[var(--app-border)]">
                                {(['view', 'contribute'] as const).map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => updateMutation.mutate({ accessMode: mode })}
                                        className={`px-3 py-1.5 text-sm ${room.accessMode === mode ? 'bg-[var(--app-button)] text-[var(--app-button-text)]' : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'}`}
                                    >
                                        {t(`studio.mode.${mode}`)}
                                    </button>
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={() => updateMutation.mutate({ rotateToken: true })}
                                className="rounded-md px-3 py-1.5 text-sm text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]"
                            >
                                {t('studio.owner.rotate')}
                            </button>
                            <button
                                type="button"
                                onClick={() => revokeMutation.mutate()}
                                className="rounded-md px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10"
                            >
                                {t('studio.owner.revoke')}
                            </button>
                        </div>
                    </section>

                    <section>
                        <div className="mb-2 flex items-center justify-between">
                            <h2 className="text-xs font-semibold uppercase text-[var(--app-hint)]">{t('studio.owner.suggestions')}</h2>
                            <span className="text-xs text-[var(--app-hint)]">{suggestions.filter((post) => post.status === 'open').length}</span>
                        </div>
                        <div className="overflow-hidden rounded-md border border-[var(--app-border)]">
                            {suggestions.length === 0 ? (
                                <div className="p-4 text-center text-sm text-[var(--app-hint)]">{t('studio.owner.noSuggestions')}</div>
                            ) : suggestions.map((post) => (
                                <SuggestionRow
                                    key={post.id}
                                    post={post}
                                    disabled={decisionMutation.isPending}
                                    onSubmit={(text) => decisionMutation.mutate({ postId: post.id, action: 'submit', text })}
                                    onDismiss={() => decisionMutation.mutate({ postId: post.id, action: 'dismiss' })}
                                />
                            ))}
                        </div>
                    </section>

                    <section>
                        <h2 className="mb-2 text-xs font-semibold uppercase text-[var(--app-hint)]">{t('studio.owner.discussion')}</h2>
                        <div className="divide-y divide-[var(--app-border)] rounded-md border border-[var(--app-border)]">
                            {discussions.length === 0 ? (
                                <div className="p-4 text-center text-sm text-[var(--app-hint)]">{t('studio.owner.noDiscussion')}</div>
                            ) : discussions.map((post) => (
                                <div key={post.id} className="px-3 py-3">
                                    <div className="text-xs font-medium text-[var(--app-hint)]">{post.authorName}</div>
                                    <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--app-fg)]">{post.text}</div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            </main>
        </div>
    )
}
