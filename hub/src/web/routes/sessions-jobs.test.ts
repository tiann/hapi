import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { AttachedJob, AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function createSession(overrides?: Partial<Session>): Session {
    return {
        id: '11111111-1111-1111-1111-111111111111',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: { path: '/music', host: 'local', name: 'Lidarr' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

describe('session-attached jobs routes (tiann/hapi#1404)', () => {
    it('lists attachedJob on GET /sessions for inactive session', async () => {
        const session = createSession()
        const jobs = new Map<string, AttachedJob>()

        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: session.id, session }),
            resolveAttachedJobSessionId: (id: string) => id,
            resolveAttachedJobKey: (_requested: string, _owner: string, jobKey: string) => jobKey,
            getSessionsByNamespace: () => [session],
            getFutureScheduledMessageCounts: () => new Map(),
            getNextScheduledAtBySessionIds: () => new Map(),
            getPrimaryAttachedJobsBySessionIds: (ids: string[]) => {
                const map = new Map<string, AttachedJob>()
                const primary = [...jobs.values()].find((j) => j.status === 'running')
                if (primary) {
                    for (const id of ids) map.set(id, primary)
                }
                return map
            },
            getPrimaryAttachedJob: () => [...jobs.values()].find((j) => j.status === 'running') ?? null,
            allocateAttachedJobVersion: (() => {
                let n = 0
                return () => {
                    n += 1
                    return Date.now() + n
                }
            })(),
            listSessionJobs: () => [...jobs.values()],
            upsertSessionJob: (_sid: string, key: string, body: AttachedJobUpsert) => {
                const now = Date.now()
                const job: AttachedJob = {
                    key,
                    label: body.label,
                    status: body.status ?? 'running',
                    ...(body.done !== undefined ? { done: body.done } : {}),
                    ...(body.total !== undefined ? { total: body.total } : {}),
                    ...(body.remaining !== undefined ? { remaining: body.remaining } : {}),
                    ...(body.unit !== undefined ? { unit: body.unit } : {}),
                    ...(body.detail !== undefined ? { detail: body.detail } : {}),
                    heartbeatAt: now,
                    startedAt: body.startedAt ?? now,
                    updatedAt: now
                }
                jobs.set(key, job)
                return { outcome: 'upserted' as const, job }
            },
            patchSessionJob: (_sid: string, key: string, patch: AttachedJobPatch) => {
                const existing = jobs.get(key)
                if (!existing) return { outcome: 'not-found' as const }
                if (
                    patch.expectedRunId !== undefined
                    && existing.runId !== patch.expectedRunId
                ) {
                    return { outcome: 'run-mismatch' as const }
                }
                const next: AttachedJob = {
                    ...existing,
                    ...(patch.label !== undefined ? { label: patch.label } : {}),
                    ...(patch.status !== undefined ? { status: patch.status } : {}),
                    ...(patch.done !== undefined && patch.done !== null ? { done: patch.done } : {}),
                    ...(patch.remaining !== undefined && patch.remaining !== null
                        ? { remaining: patch.remaining }
                        : {}),
                    heartbeatAt: Date.now(),
                    updatedAt: Date.now()
                }
                jobs.set(key, next)
                return { outcome: 'patched' as const, job: next }
            },
            deleteSessionJob: (_sid: string, key: string) => jobs.delete(key)
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine))

        const put = await app.request(
            `http://localhost/api/sessions/${session.id}/jobs/beets`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: 'beets import',
                    remaining: 120,
                    unit: 'tracks'
                })
            }
        )
        expect(put.status).toBe(200)

        const res = await app.request('http://localhost/api/sessions')
        expect(res.status).toBe(200)
        const body = await res.json() as {
            sessions: Array<{ active: boolean; attachedJob: AttachedJob | null }>
        }
        expect(body.sessions[0]!.active).toBe(false)
        expect(body.sessions[0]!.attachedJob?.key).toBe('beets')
        expect(body.sessions[0]!.attachedJob?.remaining).toBe(120)

        const del = await app.request(
            `http://localhost/api/sessions/${session.id}/jobs/beets`,
            { method: 'DELETE' }
        )
        expect(del.status).toBe(200)
        const list = await app.request(`http://localhost/api/sessions/${session.id}/jobs`)
        const listed = await list.json() as { jobs: AttachedJob[]; primary: AttachedJob | null }
        expect(listed.jobs).toEqual([])
        expect(listed.primary).toBeNull()
    })

    it('follows jobsAccepted redirect when the pre-merge session id 404s', async () => {
        const owner = createSession({ id: '22222222-2222-2222-2222-222222222222' })
        const deletedId = '11111111-1111-1111-1111-111111111111'
        const jobs = new Map<string, AttachedJob>()
        jobs.set('beets', {
            key: 'beets',
            label: 'beets import',
            status: 'running',
            remaining: 3,
            heartbeatAt: 1,
            startedAt: 1,
            updatedAt: 1
        })

        const engine = {
            resolveSessionAccess: (id: string) => {
                if (id === owner.id) {
                    return { ok: true as const, sessionId: owner.id, session: owner }
                }
                return { ok: false as const, reason: 'not-found' as const }
            },
            resolveAttachedJobSessionId: (id: string) => (id === deletedId ? owner.id : id),
            resolveAttachedJobKey: (_requested: string, _owner: string, jobKey: string) => jobKey,
            listSessionJobs: (sid: string) => (sid === owner.id ? [...jobs.values()] : []),
            getPrimaryAttachedJob: (sid: string) => (sid === owner.id ? jobs.get('beets')! : null),
            upsertSessionJob: () => ({ outcome: 'session-not-found' as const }),
            patchSessionJob: () => ({ outcome: 'not-found' as const }),
            deleteSessionJob: () => false
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine))

        const res = await app.request(`http://localhost/api/sessions/${deletedId}/jobs`)
        expect(res.status).toBe(200)
        const body = await res.json() as { primary: AttachedJob | null }
        expect(body.primary?.key).toBe('beets')
    })

    it('rejects invalid jobKey and invalid upsert body with 400', async () => {
        const session = createSession()
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: session.id, session }),
            resolveAttachedJobSessionId: (id: string) => id,
            resolveAttachedJobKey: (_requested: string, _owner: string, jobKey: string) => jobKey,
            listSessionJobs: () => [],
            getPrimaryAttachedJob: () => null,
            upsertSessionJob: () => ({ outcome: 'session-not-found' as const }),
            patchSessionJob: () => ({ outcome: 'not-found' as const }),
            deleteSessionJob: () => false
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine))

        const badKey = await app.request(
            `http://localhost/api/sessions/${session.id}/jobs/bad key!`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 'x' })
            }
        )
        expect(badKey.status).toBe(400)

        const badBody = await app.request(
            `http://localhost/api/sessions/${session.id}/jobs/ok-key`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ remaining: 1 })
            }
        )
        expect(badBody.status).toBe(400)

        // Client must not supply heartbeatAt — hub stamps receipt time.
        const clientHeartbeat = await app.request(
            `http://localhost/api/sessions/${session.id}/jobs/ok-key`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: 'x',
                    heartbeatAt: 9_999_999_999_999
                })
            }
        )
        expect(clientHeartbeat.status).toBe(400)
    })

    it('refuses DELETE /sessions/:id while a primary attached job is running', async () => {
        const session = createSession({ active: false })
        let deleted = false
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: session.id, session }),
            getPrimaryAttachedJob: () => ({
                key: 'beets',
                label: 'beets import',
                status: 'running' as const,
                heartbeatAt: 1,
                startedAt: 1,
                updatedAt: 1
            }),
            deleteSession: async () => {
                deleted = true
            }
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createSessionsRoutes(() => engine))

        const res = await app.request(`http://localhost/api/sessions/${session.id}`, {
            method: 'DELETE'
        })
        expect(res.status).toBe(409)
        expect(deleted).toBe(false)
        const body = await res.json() as { error: string }
        expect(body.error).toMatch(/attached job is running/i)
    })
})
