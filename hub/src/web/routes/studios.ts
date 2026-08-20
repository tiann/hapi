import {
    extractAssistantPlainText,
    isObject,
    unwrapRoleWrappedRecordEnvelope
} from '@hapi/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Store, StoredMessage, StoredStudioPost, StoredStudioRoom } from '../../store'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession, requireSyncEngine } from './guards'

const createRoomSchema = z.object({
    sessionId: z.string().min(1),
    title: z.string().trim().min(1).max(120).optional(),
    accessMode: z.enum(['view', 'contribute']).default('contribute')
})

const updateRoomSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    accessMode: z.enum(['view', 'contribute']).optional(),
    rotateToken: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0)

const postSchema = z.object({
    guestId: z.string().trim().min(8).max(100),
    authorName: z.string().trim().min(1).max(40),
    kind: z.enum(['discussion', 'suggestion']),
    text: z.string().trim().min(1).max(2000)
})

const decidePostSchema = z.object({
    action: z.enum(['submit', 'dismiss']),
    text: z.string().trim().min(1).max(4000).optional()
})

const suggestionPageQuerySchema = z.object({
    beforeAt: z.coerce.number().int().nonnegative().optional(),
    beforeId: z.string().min(1).optional()
}).refine((value) => (value.beforeAt === undefined) === (value.beforeId === undefined))

type PublicStudioMessage = {
    id: string
    role: 'user' | 'assistant'
    text: string
    createdAt: number
    seq: number
}

type PublicStudioPost = Pick<StoredStudioPost, 'id' | 'roomId' | 'authorName' | 'kind' | 'text' | 'createdAt'>

function projectPublicPost(post: StoredStudioPost): PublicStudioPost {
    return {
        id: post.id,
        roomId: post.roomId,
        authorName: post.authorName,
        kind: post.kind,
        text: post.text,
        createdAt: post.createdAt
    }
}

function sessionTitle(session: Session): string {
    const metadata = session.metadata
    const name = typeof metadata?.name === 'string' ? metadata.name.trim() : ''
    if (name) return name
    const summary = typeof metadata?.summary?.text === 'string' ? metadata.summary.text.trim() : ''
    if (summary) return summary
    const path = typeof metadata?.path === 'string' ? metadata.path.trim() : ''
    if (path) return path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Agent session'
    return 'Agent session'
}

function extractUserText(content: unknown): string | null {
    if (typeof content === 'string') return content.trim() || null
    if (!isObject(content)) return null
    if (content.type === 'text' && typeof content.text === 'string') {
        return content.text.trim() || null
    }
    if (content.type !== 'output' || !isObject(content.data) || content.data.type !== 'user') {
        return null
    }
    const message = isObject(content.data.message) ? content.data.message : null
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks
        .filter((block): block is Record<string, unknown> => isObject(block))
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text))
        .join('\n')
        .trim()
    return text || null
}

function projectMessage(message: StoredMessage): PublicStudioMessage | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) return null
    if (record.role === 'user' && message.invokedAt === null) return null
    if (isObject(record.content)) {
        const data = isObject(record.content.data) ? record.content.data : null
        if (data?.isMeta === true || data?.isCompactSummary === true) return null
    }
    if (record.role === 'user') {
        const text = extractUserText(record.content)
        return text ? { id: message.id, role: 'user', text, createdAt: message.createdAt, seq: message.seq } : null
    }
    if (record.role === 'agent' || record.role === 'assistant') {
        const text = extractAssistantPlainText(record.content)?.trim()
        return text ? { id: message.id, role: 'assistant', text, createdAt: message.createdAt, seq: message.seq } : null
    }
    return null
}

function ownerRoomPayload(store: Store, roomId: string) {
    const openSuggestionsNewestFirst = store.studios.listOpenSuggestionsPage(roomId, 200)
    const posts = [
        ...store.studios.listPostsByKind(roomId, 'discussion', 200),
        ...[...openSuggestionsNewestFirst].reverse(),
        ...store.studios.listResolvedSuggestions(roomId, 50)
    ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const oldest = openSuggestionsNewestFirst.at(-1)
    return {
        posts,
        openSuggestionCount: store.studios.countOpenSuggestions(roomId),
        nextSuggestionCursor: openSuggestionsNewestFirst.length === 200 && oldest
            ? { beforeAt: oldest.createdAt, beforeId: oldest.id }
            : null
    }
}

function publicRoom(room: StoredStudioRoom, session: Session) {
    return {
        id: room.id,
        title: room.title,
        accessMode: room.accessMode,
        active: session.active,
        agent: session.metadata?.flavor ?? 'agent',
        model: session.model ?? null,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
    }
}

const POST_RATE_WINDOW_MS = 60_000
const POST_RATE_LIMIT_PER_ROOM = 60
const MAX_POST_RATE_BUCKETS = 1_000
const MAX_STUDIO_POSTS_PER_ROOM = 2_000
const MAX_RAW_MESSAGES_SCANNED = 2_000
const postRateBuckets = new Map<string, number[]>()

function allowPost(key: string, now = Date.now()): boolean {
    const windowStart = now - POST_RATE_WINDOW_MS
    for (const [bucketKey, times] of postRateBuckets) {
        const recent = times.filter((time) => time >= windowStart)
        if (recent.length === 0) postRateBuckets.delete(bucketKey)
        else if (recent.length !== times.length) postRateBuckets.set(bucketKey, recent)
    }
    while (postRateBuckets.size >= MAX_POST_RATE_BUCKETS && !postRateBuckets.has(key)) {
        const oldestKey = postRateBuckets.keys().next().value as string | undefined
        if (!oldestKey) break
        postRateBuckets.delete(oldestKey)
    }
    const recent = (postRateBuckets.get(key) ?? []).filter((time) => time >= windowStart)
    if (recent.length >= POST_RATE_LIMIT_PER_ROOM) {
        postRateBuckets.set(key, recent)
        return false
    }
    recent.push(now)
    postRateBuckets.set(key, recent)
    return true
}

export function resetStudioPostRateLimitForTests(): void {
    postRateBuckets.clear()
}

export function createPublicStudioRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono {
    const app = new Hono()

    app.get('/public/studios/:token', (c) => {
        c.header('Cache-Control', 'no-store, private, max-age=0')
        c.header('Pragma', 'no-cache')
        const room = options.store.studios.getActiveRoomByToken(c.req.param('token'))
        if (!room) return c.json({ error: 'Studio not found or link revoked' }, 404)
        const engine = options.getSyncEngine()
        const session = engine?.resolveSessionAccess(room.sessionId, room.namespace)
        if (!engine || !session?.ok) return c.json({ error: 'Studio session unavailable' }, 503)

        const messages: PublicStudioMessage[] = []
        let before: { at: number; seq: number } | undefined
        let scanned = 0
        while (messages.length < 200 && scanned < MAX_RAW_MESSAGES_SCANNED) {
            const page = options.store.messages.getMessagesByPosition(room.sessionId, 200, before)
            if (page.length === 0) break
            scanned += page.length
            const projectedPage = page
                .map(projectMessage)
                .filter((message): message is PublicStudioMessage => message !== null)
            messages.unshift(...projectedPage)
            const first = page[0]
            before = first ? { at: first.invokedAt ?? first.createdAt, seq: first.seq } : undefined
            if (page.length < 200) break
        }
        const publicMessages = messages.slice(-200)
        const publicPosts = options.store.studios
            .listPostsByKind(room.id, 'discussion', 200)
            .filter((post) => post.status === 'open')
            .map(projectPublicPost)
        return c.json({
            room: publicRoom(room, session.session),
            messages: publicMessages,
            posts: publicPosts
        })
    })

    app.post('/public/studios/:token/posts', async (c) => {
        const room = options.store.studios.getActiveRoomByToken(c.req.param('token'))
        if (!room) return c.json({ error: 'Studio not found or link revoked' }, 404)
        if (room.accessMode !== 'contribute') {
            return c.json({ error: 'This studio is view only' }, 403)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = postSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid post' }, 400)

        if (!allowPost(`room:${room.id}`)) {
            return c.json({ error: 'Too many posts; try again shortly' }, 429)
        }
        const post = options.store.studios.createPostWithinLimit(
            { roomId: room.id, ...parsed.data },
            MAX_STUDIO_POSTS_PER_ROOM
        )
        if (!post) return c.json({ error: 'This studio has reached its post limit' }, 429)
        return c.json({ post }, 201)
    })

    return app
}

export function createStudioRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/studios', async (c) => {
        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) return engine
        const body = await c.req.json().catch(() => null)
        const parsed = createRoomSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const sessionResult = requireSession(c, engine, parsed.data.sessionId)
        if (sessionResult instanceof Response) return sessionResult

        const room = options.store.studios.createOrActivateRoom(
            sessionResult.sessionId,
            c.get('namespace'),
            parsed.data.title ?? sessionTitle(sessionResult.session),
            parsed.data.accessMode
        )
        return c.json({ room })
    })

    app.get('/studios/session/:sessionId', (c) => {
        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSession(c, engine, c.req.param('sessionId'))
        if (sessionResult instanceof Response) return sessionResult
        const room = options.store.studios.getRoomBySession(sessionResult.sessionId, c.get('namespace'))
        return room ? c.json({ room, ...ownerRoomPayload(options.store, room.id) }) : c.json({ room: null, posts: [], openSuggestionCount: 0, nextSuggestionCursor: null })
    })

    app.get('/studios/:id/suggestions', (c) => {
        const room = options.store.studios.getRoomById(c.req.param('id'), c.get('namespace'))
        if (!room) return c.json({ error: 'Studio not found' }, 404)
        const parsed = suggestionPageQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
        const before = parsed.data.beforeAt !== undefined && parsed.data.beforeId !== undefined
            ? { createdAt: parsed.data.beforeAt, id: parsed.data.beforeId }
            : undefined
        const items = options.store.studios.listOpenSuggestionsPage(room.id, 200, before)
        const oldest = items.at(-1)
        return c.json({
            items,
            nextCursor: items.length === 200 && oldest
                ? { beforeAt: oldest.createdAt, beforeId: oldest.id }
                : null
        })
    })

    app.get('/studios/:id', (c) => {
        const room = options.store.studios.getRoomById(c.req.param('id'), c.get('namespace'))
        if (!room) return c.json({ error: 'Studio not found' }, 404)
        return c.json({ room, ...ownerRoomPayload(options.store, room.id) })
    })

    app.patch('/studios/:id', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = updateRoomSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const room = options.store.studios.updateRoom(c.req.param('id'), c.get('namespace'), parsed.data)
        return room ? c.json({ room }) : c.json({ error: 'Studio not found' }, 404)
    })

    app.delete('/studios/:id', (c) => {
        const revoked = options.store.studios.revokeRoom(c.req.param('id'), c.get('namespace'))
        return revoked ? c.json({ ok: true }) : c.json({ error: 'Studio not found' }, 404)
    })

    app.delete('/studios/:id/posts', (c) => {
        const room = options.store.studios.getRoomById(c.req.param('id'), c.get('namespace'))
        if (!room) return c.json({ error: 'Studio not found' }, 404)
        const deleted = options.store.studios.clearPosts(room.id)
        return c.json({ ok: true, deleted })
    })

    app.post('/studios/:id/posts/:postId/decision', async (c) => {
        const room = options.store.studios.getRoomById(c.req.param('id'), c.get('namespace'))
        if (!room) return c.json({ error: 'Studio not found' }, 404)
        const body = await c.req.json().catch(() => null)
        const parsed = decidePostSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (parsed.data.action === 'dismiss') {
            const post = options.store.studios.getPost(c.req.param('postId'), room.id)
            if (!post || post.status !== 'open') {
                return c.json({ error: 'Open post not found' }, 404)
            }
            const updated = options.store.studios.decidePost(post.id, room.id, 'dismissed')
            return c.json({ post: updated })
        }

        const post = options.store.studios.getPost(c.req.param('postId'), room.id)
        if (!post || post.kind !== 'suggestion' || post.status !== 'open') {
            return c.json({ error: 'Open suggestion not found' }, 404)
        }

        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSession(c, engine, room.sessionId, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        const text = parsed.data.text ?? post.text
        const claimed = options.store.studios.decidePost(post.id, room.id, 'submitted', text)
        if (!claimed) return c.json({ error: 'Suggestion already handled' }, 409)
        try {
            await engine.sendMessage(room.sessionId, {
                text: `[Studio suggestion from ${post.authorName}]\n${text}`,
                localId: `studio-${post.id}`,
                sentFrom: 'webapp',
                deliveryMode: 'queue'
            })
            return c.json({ post: options.store.studios.getPost(post.id, room.id) })
        } catch (error) {
            options.store.studios.reopenPost(post.id, room.id)
            return c.json({ error: error instanceof Error ? error.message : 'Failed to submit suggestion' }, 502)
        }
    })

    return app
}
