import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PublicStudioMessage, PublicStudioResponse, StudioPostKind } from '@/types/api'
import {
    countNewStudioMessages,
    isStudioNearBottom,
    shouldCollapseStudioMessage,
    shouldAutoJumpOnTabOpen
} from './studioBehavior'
import { resolveStudioApiOrigin } from './studioUrl'

type Locale = 'en' | 'zh-CN'
type Copy = {
    loading: string
    notFound: string
    owner: string
    agent: string
    discussion: string
    conversation: string
    emptyDiscussion: string
    name: string
    discuss: string
    suggest: string
    discussionPlaceholder: string
    suggestionPlaceholder: string
    send: string
    sending: string
    postFailed: string
    suggestionHint: string
    expand: string
    collapse: string
    jumpToLatest: string
    newMessages: (count: number) => string
}

const COPY: Record<Locale, Copy> = {
    en: {
        loading: 'Loading studio…', notFound: 'This studio is unavailable or its link was revoked.', owner: 'Host', agent: 'Agent',
        discussion: 'Discussion', conversation: 'Conversation', emptyDiscussion: 'No discussion yet.', name: 'Your name',
        discuss: 'Discuss', suggest: 'Suggest', discussionPlaceholder: 'Add a comment…', suggestionPlaceholder: 'Suggest the next step…',
        send: 'Post', sending: 'Posting…', postFailed: 'Could not post', suggestionHint: 'Suggestions go to the host for confirmation before they are sent to the session.', expand: 'Show more', collapse: 'Show less',
        jumpToLatest: 'Jump to latest', newMessages: (count) => `${count} new message${count === 1 ? '' : 's'}`
    },
    'zh-CN': {
        loading: '正在加载工作室…', notFound: '工作室不可用，或分享链接已撤销。', owner: '主持人', agent: 'Agent',
        discussion: '讨论', conversation: '对话', emptyDiscussion: '暂时没有讨论。', name: '你的称呼',
        discuss: '讨论', suggest: '建议', discussionPlaceholder: '发表讨论…', suggestionPlaceholder: '建议下一步做什么…',
        send: '发送', sending: '发送中…', postFailed: '发送失败', suggestionHint: '建议会先交给主持人确认，确认后再发送到当前会话。', expand: '展开全文', collapse: '收起',
        jumpToLatest: '回到底部', newMessages: (count) => `${count} 条新消息`
    }
}

const GUEST_ID_KEY = 'hapi.studio.guestId'
const GUEST_NAME_KEY = 'hapi.studio.guestName'

function getLocale(): Locale {
    const saved = localStorage.getItem('hapi-lang')
    if (saved === 'en' || saved === 'zh-CN') return saved
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function getGuestId(): string {
    const existing = localStorage.getItem(GUEST_ID_KEY)
    if (existing) return existing
    const id = `guest-${crypto.randomUUID()}`
    localStorage.setItem(GUEST_ID_KEY, id)
    return id
}

function getToken(): string {
    const match = window.location.pathname.match(/\/studio\/([^/]+)/)
    return match?.[1] ?? new URLSearchParams(window.location.search).get('token') ?? ''
}

async function loadStudio(token: string, apiOrigin: string): Promise<PublicStudioResponse> {
    const response = await fetch(new URL(`/api/public/studios/${encodeURIComponent(token)}`, apiOrigin), {
        cache: 'no-store'
    })
    if (!response.ok) throw new Error('not-found')
    return await response.json() as PublicStudioResponse
}

function AssistantMessageBody(props: { message: PublicStudioMessage; latestAssistant: boolean; copy: Copy }) {
    const collapsible = shouldCollapseStudioMessage(props.message.text)
    const [expanded, setExpanded] = useState(props.latestAssistant || !collapsible)
    return (
        <div className="studio-assistant-response">
            <div className={`studio-message-content ${collapsible && !expanded ? 'collapsed' : ''}`}>
                <div className="studio-message-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.message.text}</ReactMarkdown>
                </div>
                {collapsible && !expanded ? <div className="studio-message-fade" aria-hidden="true" /> : null}
            </div>
            {collapsible ? (
                <button className="studio-collapse-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
                    {expanded ? props.copy.collapse : props.copy.expand}
                </button>
            ) : null}
        </div>
    )
}

function MessageBody(props: { message: PublicStudioMessage; latestAssistant: boolean; copy: Copy }) {
    if (props.message.role === 'user') {
        return <div className="studio-message-body">{props.message.text}</div>
    }
    return <AssistantMessageBody {...props} />
}

function StudioPage() {
    const [locale] = useState<Locale>(getLocale)
    const copy = COPY[locale]
    const token = getToken()
    const apiOrigin = resolveStudioApiOrigin(new URLSearchParams(window.location.search).get('hub'), window.location.origin)
    const [data, setData] = useState<PublicStudioResponse | null>(null)
    const [loadError, setLoadError] = useState(false)
    const [tab, setTab] = useState<'conversation' | 'discussion'>('conversation')
    const [guestId] = useState(getGuestId)
    const [authorName, setAuthorName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) ?? '')
    const [kind, setKind] = useState<StudioPostKind>('suggestion')
    const [text, setText] = useState('')
    const [sending, setSending] = useState(false)
    const [postError, setPostError] = useState<string | null>(null)
    const [nearBottom, setNearBottom] = useState(true)
    const [unreadCount, setUnreadCount] = useState(0)
    const conversationRef = useRef<HTMLDivElement | null>(null)
    const previousLastMessageIdRef = useRef<string | null>(null)
    const initialScrollDoneRef = useRef(false)
    const initialScrollTimersRef = useRef<number[]>([])
    const previousTabRef = useRef(tab)

    useEffect(() => {
        let stopped = false
        const fetchData = async () => {
            try {
                const next = await loadStudio(token, apiOrigin)
                if (!stopped) {
                    setData(next)
                    setLoadError(false)
                }
            } catch {
                if (!stopped) setLoadError(true)
            }
        }
        void fetchData()
        const interval = window.setInterval(() => {
            if (document.visibilityState === 'visible') void fetchData()
        }, 5_000)
        return () => {
            stopped = true
            window.clearInterval(interval)
        }
    }, [apiOrigin, token])

    const discussions = useMemo(
        () => data?.posts.filter((post) => post.roomId === data.room.id && post.kind === 'discussion') ?? [],
        [data]
    )
    const latestAssistantId = useMemo(
        () => [...(data?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.id ?? null,
        [data?.messages]
    )

    const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
        const element = conversationRef.current
        if (!element) return
        const top = element.scrollHeight
        element.scrollTop = top
        element.scrollTo({ top, behavior })
        setNearBottom(true)
        setUnreadCount(0)
    }, [])

    useLayoutEffect(() => {
        const messages = data?.messages ?? []
        if (messages.length === 0) return undefined
        const nextLastId = messages.at(-1)?.id ?? null
        const previousLastId = previousLastMessageIdRef.current

        if (!initialScrollDoneRef.current) {
            previousLastMessageIdRef.current = nextLastId
            initialScrollTimersRef.current.forEach((timer) => window.clearTimeout(timer))
            initialScrollTimersRef.current = [0, 60, 180, 420].map((delay) => window.setTimeout(() => {
                scrollToLatest('auto')
                if (delay === 420) initialScrollDoneRef.current = true
            }, delay))
            return () => {
                initialScrollTimersRef.current.forEach((timer) => window.clearTimeout(timer))
                initialScrollTimersRef.current = []
            }
        }

        if (nextLastId && nextLastId !== previousLastId) {
            const appended = countNewStudioMessages(previousLastId, messages)
            previousLastMessageIdRef.current = nextLastId
            if (nearBottom) {
                const frame = window.requestAnimationFrame(() => scrollToLatest('smooth'))
                return () => window.cancelAnimationFrame(frame)
            }
            setUnreadCount((count) => count + appended)
        }
        return undefined
    }, [data?.messages, nearBottom, scrollToLatest])

    useEffect(() => {
        const openedConversation = shouldAutoJumpOnTabOpen(previousTabRef.current, tab, unreadCount)
        previousTabRef.current = tab
        if (openedConversation) scrollToLatest('smooth')
    }, [scrollToLatest, tab, unreadCount])

    const submitPost = async () => {
        if (!authorName.trim() || !text.trim() || sending) return
        setSending(true)
        setPostError(null)
        try {
            const response = await fetch(new URL(`/api/public/studios/${encodeURIComponent(token)}/posts`, apiOrigin), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ guestId, authorName: authorName.trim(), kind, text: text.trim() })
            })
            if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? copy.postFailed)
            localStorage.setItem(GUEST_NAME_KEY, authorName.trim())
            setText('')
            const next = await loadStudio(token, apiOrigin)
            setData(next)
        } catch (error) {
            setPostError(error instanceof Error ? error.message : copy.postFailed)
        } finally {
            setSending(false)
        }
    }

    if (!data && !loadError) return <div className="studio-loading">{copy.loading}</div>
    if (!data || loadError) return <div className="studio-not-found">{copy.notFound}</div>

    return (
        <div className="studio-shell">
            <header className="studio-header">
                <div className="studio-header-inner">
                    <div className="studio-title">
                        <h1>{data.room.title}</h1>
                        <div className="studio-meta"><span>{data.room.agent}</span>{data.room.model ? <><span>·</span><span>{data.room.model}</span></> : null}</div>
                    </div>
                    <span className={`studio-status ${data.room.active ? 'online' : ''}`} />
                </div>
            </header>
            <nav className="studio-tabs">
                <button type="button" className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}>{copy.conversation}</button>
                <button type="button" className={tab === 'discussion' ? 'active' : ''} onClick={() => setTab('discussion')}>{copy.discussion}</button>
            </nav>
            <main className="studio-main">
                <div className="studio-layout">
                    <section className={`studio-conversation ${tab === 'conversation' ? '' : 'hidden'}`}>
                        <div
                            ref={conversationRef}
                            className="studio-conversation-scroll"
                            onScroll={(event) => {
                                const atBottom = isStudioNearBottom(event.currentTarget)
                                setNearBottom(atBottom)
                                if (atBottom) setUnreadCount(0)
                            }}
                        >
                        <div className="studio-message-list">
                            {data.messages.map((message) => (
                                <article className={`studio-message ${message.role}`} key={message.id}>
                                    <div className="studio-label">{message.role === 'user' ? copy.owner : copy.agent}</div>
                                    <MessageBody message={message} latestAssistant={message.id === latestAssistantId} copy={copy} />
                                </article>
                            ))}
                        </div>
                        </div>
                        {!nearBottom ? (
                            <button className="studio-jump-latest" type="button" onClick={() => scrollToLatest()}>
                                {unreadCount > 0 ? copy.newMessages(unreadCount) : copy.jumpToLatest}
                                <span aria-hidden="true">↓</span>
                            </button>
                        ) : null}
                    </section>
                    <aside className={`studio-discussion ${tab === 'discussion' ? '' : 'hidden'}`}>
                        <h2 className="studio-section-title">{copy.discussion}</h2>
                        <div className="studio-discussion-list">
                            {discussions.length === 0 ? <div className="studio-empty">{copy.emptyDiscussion}</div> : discussions.map((post) => (
                                <div className="studio-discussion-item" key={post.id}>
                                    <div className="studio-author">{post.authorName}</div>
                                    <div className="studio-discussion-text">{post.text}</div>
                                </div>
                            ))}
                        </div>
                        {data.room.accessMode === 'contribute' ? (
                            <div className="studio-form">
                                <input className="studio-input" value={authorName} maxLength={40} onChange={(event) => setAuthorName(event.target.value)} placeholder={copy.name} />
                                <div className="studio-kind">
                                    <button type="button" className={kind === 'suggestion' ? 'active' : ''} onClick={() => setKind('suggestion')}>{copy.suggest}</button>
                                    <button type="button" className={kind === 'discussion' ? 'active' : ''} onClick={() => setKind('discussion')}>{copy.discuss}</button>
                                </div>
                                {kind === 'suggestion' ? <div className="studio-form-hint">{copy.suggestionHint}</div> : null}
                                <textarea className="studio-textarea" value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} placeholder={kind === 'discussion' ? copy.discussionPlaceholder : copy.suggestionPlaceholder} />
                                {postError ? <div className="studio-error">{postError}</div> : null}
                                <button className="studio-send" type="button" disabled={!authorName.trim() || !text.trim() || sending} onClick={() => void submitPost()}>{sending ? copy.sending : copy.send}</button>
                            </div>
                        ) : null}
                    </aside>
                </div>
            </main>
        </div>
    )
}

export default function StudioLiteApp() {
    return <StudioPage />
}
