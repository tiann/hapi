import type { Database } from 'bun:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import type {
    StoredStudioPost,
    StoredStudioRoom,
    StudioAccessMode,
    StudioPostKind,
    StudioPostStatus
} from './types'

type StudioRoomRow = {
    id: string
    session_id: string
    namespace: string
    title: string
    share_token: string
    access_mode: StudioAccessMode
    status: 'active' | 'revoked'
    created_at: number
    updated_at: number
}

type StudioPostRow = {
    id: string
    room_id: string
    guest_id: string
    author_name: string
    kind: StudioPostKind
    text: string
    status: StudioPostStatus
    created_at: number
    decided_at: number | null
    submitted_text: string | null
}

function mapRoom(row: StudioRoomRow): StoredStudioRoom {
    return {
        id: row.id,
        sessionId: row.session_id,
        namespace: row.namespace,
        title: row.title,
        shareToken: row.share_token,
        accessMode: row.access_mode,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function mapPost(row: StudioPostRow): StoredStudioPost {
    return {
        id: row.id,
        roomId: row.room_id,
        guestId: row.guest_id,
        authorName: row.author_name,
        kind: row.kind,
        text: row.text,
        status: row.status,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        submittedText: row.submitted_text
    }
}

export class StudioStore {
    constructor(private readonly db: Database) {}

    private insertPost(input: {
        roomId: string
        guestId: string
        authorName: string
        kind: StudioPostKind
        text: string
        createdAt?: number
    }): StoredStudioPost {
        const id = randomUUID()
        const now = input.createdAt ?? Date.now()
        this.db.prepare(`
            INSERT INTO studio_posts (
                id, room_id, guest_id, author_name, kind, text,
                status, created_at, decided_at, submitted_text
            ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)
        `).run(id, input.roomId, input.guestId, input.authorName, input.kind, input.text, now)
        return this.getPost(id, input.roomId)!
    }

    createOrActivateRoom(
        sessionId: string,
        namespace: string,
        title: string,
        accessMode: StudioAccessMode
    ): StoredStudioRoom {
        return this.db.transaction(() => {
            const existing = this.getRoomBySession(sessionId, namespace)
            const now = Date.now()
            if (existing) {
                const shareToken = existing.status === 'revoked'
                    ? randomBytes(32).toString('base64url')
                    : existing.shareToken
                this.db.prepare(`
                    UPDATE studio_rooms
                    SET title = ?, access_mode = ?, share_token = ?, status = 'active', updated_at = ?
                    WHERE id = ? AND namespace = ?
                `).run(title, accessMode, shareToken, now, existing.id, namespace)
                return this.getRoomById(existing.id, namespace)!
            }

            const id = randomUUID()
            const shareToken = randomBytes(32).toString('base64url')
            this.db.prepare(`
                INSERT INTO studio_rooms (
                    id, session_id, namespace, title, share_token,
                    access_mode, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
            `).run(id, sessionId, namespace, title, shareToken, accessMode, now, now)
            return this.getRoomById(id, namespace)!
        })()
    }

    getRoomById(id: string, namespace: string): StoredStudioRoom | null {
        const row = this.db.prepare(
            'SELECT * FROM studio_rooms WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as StudioRoomRow | undefined
        return row ? mapRoom(row) : null
    }

    getRoomBySession(sessionId: string, namespace: string): StoredStudioRoom | null {
        const row = this.db.prepare(
            'SELECT * FROM studio_rooms WHERE session_id = ? AND namespace = ?'
        ).get(sessionId, namespace) as StudioRoomRow | undefined
        return row ? mapRoom(row) : null
    }

    getActiveRoomByToken(token: string): StoredStudioRoom | null {
        const row = this.db.prepare(
            "SELECT * FROM studio_rooms WHERE share_token = ? AND status = 'active'"
        ).get(token) as StudioRoomRow | undefined
        return row ? mapRoom(row) : null
    }

    updateRoom(
        id: string,
        namespace: string,
        input: { title?: string; accessMode?: StudioAccessMode; rotateToken?: boolean }
    ): StoredStudioRoom | null {
        const current = this.getRoomById(id, namespace)
        if (!current) return null
        const token = input.rotateToken ? randomBytes(32).toString('base64url') : current.shareToken
        this.db.prepare(`
            UPDATE studio_rooms
            SET title = ?, access_mode = ?, share_token = ?, updated_at = ?
            WHERE id = ? AND namespace = ?
        `).run(
            input.title ?? current.title,
            input.accessMode ?? current.accessMode,
            token,
            Date.now(),
            id,
            namespace
        )
        return this.getRoomById(id, namespace)
    }

    revokeRoom(id: string, namespace: string): boolean {
        const result = this.db.prepare(`
            UPDATE studio_rooms SET status = 'revoked', updated_at = ?
            WHERE id = ? AND namespace = ?
        `).run(Date.now(), id, namespace)
        return result.changes > 0
    }

    listPosts(roomId: string, limit = 200): StoredStudioPost[] {
        const rows = this.db.prepare(`
            SELECT * FROM (
                SELECT * FROM studio_posts
                WHERE room_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
            ORDER BY created_at ASC, id ASC
        `).all(roomId, limit) as StudioPostRow[]
        return rows.map(mapPost)
    }

    listPostsByKind(
        roomId: string,
        kind: StudioPostKind,
        limit: number | null = 200
    ): StoredStudioPost[] {
        const limitClause = limit === null ? '' : 'LIMIT ?'
        const params = limit === null ? [roomId, kind] : [roomId, kind, limit]
        const rows = this.db.prepare(`
            SELECT * FROM studio_posts
            WHERE room_id = ? AND kind = ?
            ORDER BY created_at DESC, id DESC
            ${limitClause}
        `).all(...params) as StudioPostRow[]
        return rows.reverse().map(mapPost)
    }

    listOpenSuggestions(roomId: string, limit: number | null = null): StoredStudioPost[] {
        const limitClause = limit === null ? '' : 'LIMIT ?'
        const params = limit === null ? [roomId] : [roomId, limit]
        const rows = this.db.prepare(`
            SELECT * FROM studio_posts
            WHERE room_id = ? AND kind = 'suggestion' AND status = 'open'
            ORDER BY created_at DESC, id DESC
            ${limitClause}
        `).all(...params) as StudioPostRow[]
        return rows.reverse().map(mapPost)
    }

    listOpenSuggestionsPage(
        roomId: string,
        limit = 200,
        before?: { createdAt: number; id: string }
    ): StoredStudioPost[] {
        const beforeClause = before
            ? 'AND (created_at < ? OR (created_at = ? AND id < ?))'
            : ''
        const params = before
            ? [roomId, before.createdAt, before.createdAt, before.id, limit]
            : [roomId, limit]
        return (this.db.prepare(`
            SELECT * FROM studio_posts
            WHERE room_id = ? AND kind = 'suggestion' AND status = 'open'
            ${beforeClause}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        `).all(...params) as StudioPostRow[]).map(mapPost)
    }

    countOpenSuggestions(roomId: string): number {
        const row = this.db.prepare(
            "SELECT COUNT(*) AS count FROM studio_posts WHERE room_id = ? AND kind = 'suggestion' AND status = 'open'"
        ).get(roomId) as { count: number }
        return row.count
    }

    listResolvedSuggestions(roomId: string, limit = 50): StoredStudioPost[] {
        const rows = this.db.prepare(`
            SELECT * FROM studio_posts
            WHERE room_id = ? AND kind = 'suggestion' AND status != 'open'
            ORDER BY decided_at DESC, created_at DESC, id DESC
            LIMIT ?
        `).all(roomId, limit) as StudioPostRow[]
        return rows.reverse().map(mapPost)
    }

    createPost(input: {
        roomId: string
        guestId: string
        authorName: string
        kind: StudioPostKind
        text: string
        createdAt?: number
    }): StoredStudioPost {
        return this.insertPost(input)
    }

    /**
     * Atomically enforce a lifetime post cap for public rooms. The in-memory
     * rate limiter protects bursts, while this durable cap protects the hub's
     * SQLite file across restarts and rotating guest identities.
     */
    createPostWithinLimit(
        input: {
            roomId: string
            guestId: string
            authorName: string
            kind: StudioPostKind
            text: string
            createdAt?: number
        },
        maxPosts: number
    ): StoredStudioPost | null {
        const limit = Math.max(1, Math.floor(maxPosts))
        return this.db.transaction(() => {
            const row = this.db.prepare(
                'SELECT COUNT(*) AS count FROM studio_posts WHERE room_id = ?'
            ).get(input.roomId) as { count: number }
            if (row.count >= limit) return null
            return this.insertPost(input)
        })()
    }

    getPost(id: string, roomId: string): StoredStudioPost | null {
        const row = this.db.prepare(
            'SELECT * FROM studio_posts WHERE id = ? AND room_id = ?'
        ).get(id, roomId) as StudioPostRow | undefined
        return row ? mapPost(row) : null
    }

    decidePost(
        id: string,
        roomId: string,
        status: Extract<StudioPostStatus, 'submitted' | 'dismissed'>,
        submittedText?: string
    ): StoredStudioPost | null {
        const result = this.db.prepare(`
            UPDATE studio_posts
            SET status = ?, decided_at = ?, submitted_text = ?
            WHERE id = ? AND room_id = ? AND status = 'open'
        `).run(status, Date.now(), submittedText ?? null, id, roomId)
        return result.changes > 0 ? this.getPost(id, roomId) : null
    }

    reopenPost(id: string, roomId: string): void {
        this.db.prepare(`
            UPDATE studio_posts
            SET status = 'open', decided_at = NULL, submitted_text = NULL
            WHERE id = ? AND room_id = ? AND status = 'submitted'
        `).run(id, roomId)
    }
}
