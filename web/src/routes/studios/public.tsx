import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { PublicStudioResponse, StudioPostKind } from '@/types/api'

const GUEST_ID_KEY = 'hapi.studio.guestId'
const GUEST_NAME_KEY = 'hapi.studio.guestName'

function getGuestId(): string {
    const existing = localStorage.getItem(GUEST_ID_KEY)
    if (existing) return existing
    const id = `guest-${crypto.randomUUID()}`
    localStorage.setItem(GUEST_ID_KEY, id)
    return id
}

async function requestStudio(token: string): Promise<PublicStudioResponse> {
    const response = await fetch(`/api/public/studios/${encodeURIComponent(token)}`)
    if (!response.ok) throw new Error(response.status === 404 ? 'not-found' : 'unavailable')
    return await response.json() as PublicStudioResponse
}

export default function PublicStudioPage() {
    const { shareToken } = useParams({ from: '/studio/$shareToken' })
    const { t, setLocale } = useTranslation()
    const queryClient = useQueryClient()
    const [guestId] = useState(getGuestId)
    const [authorName, setAuthorName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) ?? '')
    const [kind, setKind] = useState<StudioPostKind>('discussion')
    const [text, setText] = useState('')
    const [postError, setPostError] = useState<string | null>(null)
    const [mobileTab, setMobileTab] = useState<'conversation' | 'discussion'>('conversation')

    const query = useQuery({
        queryKey: ['public-studio', shareToken],
        queryFn: () => requestStudio(shareToken),
        refetchInterval: 2_000,
        retry: false
    })
    const posts = query.data?.posts ?? []
    const discussions = useMemo(() => posts.filter((post) => post.kind === 'discussion'), [posts])

    useEffect(() => {
        if (authorName.trim()) localStorage.setItem(GUEST_NAME_KEY, authorName.trim())
    }, [authorName])

    useEffect(() => {
        if (!localStorage.getItem('hapi-lang') && navigator.language.toLowerCase().startsWith('zh')) {
            setLocale('zh-CN')
        }
    }, [setLocale])

    const postMutation = useMutation({
        mutationFn: async () => {
            const response = await fetch(`/api/public/studios/${encodeURIComponent(shareToken)}/posts`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ guestId, authorName: authorName.trim(), kind, text: text.trim() })
            })
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string }
                throw new Error(body.error ?? 'post-failed')
            }
        },
        onSuccess: async () => {
            setText('')
            setPostError(null)
            await queryClient.invalidateQueries({ queryKey: ['public-studio', shareToken] })
        },
        onError: (error) => setPostError(error instanceof Error ? error.message : t('studio.guest.postFailed'))
    })

    if (query.isLoading) {
        return <div className="flex h-full items-center justify-center"><LoadingState label={t('studio.loading')} /></div>
    }
    if (!query.data || query.isError) {
        return <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--app-hint)]">{t('studio.notFound')}</div>
    }

    const { room, messages } = query.data
    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="border-b border-[var(--app-border)] px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <div className="mx-auto flex max-w-[72rem] items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate text-base font-semibold text-[var(--app-fg)]">{room.title}</h1>
                        <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                            <span>{room.agent}</span>
                            {room.model ? <><span>·</span><span>{room.model}</span></> : null}
                        </div>
                    </div>
                    <span className={`h-2.5 w-2.5 rounded-full ${room.active ? 'bg-green-500' : 'bg-[var(--app-hint)]'}`} />
                </div>
            </header>

            <nav className="grid grid-cols-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-1 md:hidden">
                {(['conversation', 'discussion'] as const).map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => setMobileTab(tab)}
                        className={`h-9 rounded-md text-sm font-medium ${mobileTab === tab ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        {t(`studio.guest.tab.${tab}`)}
                    </button>
                ))}
            </nav>

            <main className="min-h-0 flex-1 overflow-hidden">
                <div className="mx-auto grid h-full max-w-[72rem] grid-cols-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_20rem]">
                    <section className={`${mobileTab === 'conversation' ? 'block' : 'hidden'} app-scroll-y min-h-0 md:block md:border-r`}>
                        <div className="mx-auto max-w-[52rem] space-y-4 px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5">
                            {messages.map((message) => (
                                <div
                                    key={message.id}
                                    className={`min-w-0 rounded-md px-3.5 py-3 ${message.role === 'user' ? 'ml-auto max-w-[88%] bg-[var(--app-user-bg)] text-[var(--app-user-fg)]' : 'w-full border border-[var(--app-border)] bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'}`}
                                >
                                    <div className="mb-1 text-[10px] font-semibold uppercase opacity-60">
                                        {t(message.role === 'user' ? 'studio.guest.owner' : 'studio.guest.agent')}
                                    </div>
                                    {message.role === 'assistant' ? (
                                        <MarkdownRenderer standalone content={message.text} className="text-sm leading-6" />
                                    ) : (
                                        <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.text}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>

                    <aside className={`${mobileTab === 'discussion' ? 'block' : 'hidden'} app-scroll-y min-h-0 md:block`}>
                        <div className="space-y-5 p-3 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:p-4 sm:pb-[calc(2rem+env(safe-area-inset-bottom))]">
                            <section>
                                <h2 className="mb-2 text-xs font-semibold uppercase text-[var(--app-hint)]">{t('studio.owner.discussion')}</h2>
                                <div className="divide-y divide-[var(--app-border)] rounded-md border border-[var(--app-border)]">
                                    {discussions.length === 0 ? (
                                        <div className="p-3 text-center text-xs text-[var(--app-hint)]">{t('studio.owner.noDiscussion')}</div>
                                    ) : discussions.map((post) => (
                                        <div key={post.id} className="p-3">
                                            <div className="text-xs font-medium text-[var(--app-hint)]">{post.authorName}</div>
                                            <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--app-fg)]">{post.text}</div>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            {room.accessMode === 'contribute' ? (
                                <section className="space-y-2">
                                    <input
                                        value={authorName}
                                        onChange={(event) => setAuthorName(event.target.value)}
                                        maxLength={40}
                                        placeholder={t('studio.guest.name')}
                                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                                    />
                                    <div className="inline-flex overflow-hidden rounded-md border border-[var(--app-border)]">
                                        {(['discussion', 'suggestion'] as const).map((value) => (
                                            <button
                                                key={value}
                                                type="button"
                                                onClick={() => setKind(value)}
                                                className={`px-3 py-1.5 text-sm ${kind === value ? 'bg-[var(--app-button)] text-[var(--app-button-text)]' : 'text-[var(--app-hint)]'}`}
                                            >
                                                {t(`studio.post.kind.${value}`)}
                                            </button>
                                        ))}
                                    </div>
                                    <textarea
                                        value={text}
                                        onChange={(event) => setText(event.target.value)}
                                        maxLength={2000}
                                        rows={4}
                                        placeholder={t(`studio.guest.placeholder.${kind}`)}
                                        className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                                    />
                                    {postError ? <div className="text-xs text-red-500">{postError}</div> : null}
                                    <button
                                        type="button"
                                        disabled={!authorName.trim() || !text.trim() || postMutation.isPending}
                                        onClick={() => postMutation.mutate()}
                                        className="w-full rounded-md bg-[var(--app-button)] px-3 py-2 text-sm text-[var(--app-button-text)] disabled:opacity-50"
                                    >
                                        {postMutation.isPending ? t('studio.guest.sending') : t('studio.guest.send')}
                                    </button>
                                </section>
                            ) : null}
                        </div>
                    </aside>
                </div>
            </main>
        </div>
    )
}
