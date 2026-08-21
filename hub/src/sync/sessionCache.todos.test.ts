import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache, STRUCTURED_TODOS_BACKFILL_MIGRATION_ID } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('SessionCache structured task backfill', () => {
    it('restores Codex update_plan tasks when a session is reopened', () => {
        const store = new Store(':memory:')
        const created = store.sessions.getOrCreateSession('codex-plan-reopen', { path: '/tmp', host: 'h' }, null, 'default')
        store.messages.addMessage(created.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'update_plan',
                    input: {
                        plan: [{ step: 'Reopen the task state', status: 'in_progress' }]
                    }
                }
            }
        })

        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const reopened = cache.refreshSession(created.id)

        expect(reopened?.todos).toEqual([
            {
                content: 'Reopen the task state',
                priority: 'medium',
                status: 'in_progress',
                id: 'plan-1'
            }
        ])
    })

    it('refreshes an older persisted TodoWrite snapshot from a newer structured plan', () => {
        const store = new Store(':memory:')
        const created = store.sessions.getOrCreateSession('structured-plan-after-todowrite', { path: '/tmp', host: 'h' }, null, 'default')
        const oldAt = 1_000
        const newAt = 2_000
        const oldTodos = [{ content: 'Old task state', priority: 'medium', status: 'pending', id: 'old-1' }]

        store.sessions.setSessionTodos(created.id, oldTodos, oldAt, 'default')
        store.messages.addMessage(created.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'update_plan',
                    input: {
                        plan: [{ step: 'New structured plan', status: 'in_progress' }]
                    }
                }
            }
        }, undefined, undefined, newAt)

        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const reopened = cache.refreshSession(created.id)

        expect(reopened?.todos).toEqual([
            {
                content: 'New structured plan',
                priority: 'medium',
                status: 'in_progress',
                id: 'plan-1'
            }
        ])
        expect(reopened?.todosUpdatedAt).toBe(newAt)
    })

    it('finds a newer structured plan beyond the latest 200 messages', () => {
        const store = new Store(':memory:')
        const created = store.sessions.getOrCreateSession('long-structured-plan-reopen', { path: '/tmp', host: 'h' }, null, 'default')
        const oldAt = 1_000
        const planAt = 2_000

        store.sessions.setSessionTodos(created.id, [
            { content: 'Old task state', priority: 'medium', status: 'pending', id: 'old-1' }
        ], oldAt, 'default')
        store.messages.addMessage(created.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'update_plan',
                    input: {
                        plan: [{ step: 'Plan before long history', status: 'in_progress' }]
                    }
                }
            }
        }, undefined, undefined, planAt)
        for (let i = 0; i < 200; i += 1) {
            store.messages.addMessage(created.id, { role: 'assistant', content: `history-${i}` }, undefined, undefined, planAt + i + 1)
        }

        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const reopened = cache.refreshSession(created.id)

        expect(reopened?.todos).toEqual([
            {
                content: 'Plan before long history',
                priority: 'medium',
                status: 'in_progress',
                id: 'plan-1'
            }
        ])
    })

    it('persists the one-time backfill marker and skips the scan after restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-structured-todos-backfill-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const store = new Store(dbPath)
        const created = store.sessions.getOrCreateSession('persistent-plan-backfill', { path: '/tmp', host: 'h' }, null, 'default')
        store.messages.addMessage(created.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'update_plan',
                    input: { plan: [{ step: 'Persist this migration', status: 'in_progress' }] }
                }
            }
        })

        let scanCount = 0
        const originalGetMessagesBeforeSeq = store.messages.getMessagesBeforeSeq.bind(store.messages)
        store.messages.getMessagesBeforeSeq = (...args) => {
            scanCount += 1
            return originalGetMessagesBeforeSeq(...args)
        }

        const firstCache = new SessionCache(store, createPublisher([]))
        firstCache.reloadAll()

        expect(store.migrations.isCompleted(STRUCTURED_TODOS_BACKFILL_MIGRATION_ID)).toBe(true)
        expect(scanCount).toBe(1)

        store.close()

        const reopenedStore = new Store(dbPath)
        try {
            const restartedOriginalGetMessagesBeforeSeq = reopenedStore.messages.getMessagesBeforeSeq.bind(reopenedStore.messages)
            reopenedStore.messages.getMessagesBeforeSeq = (...args) => {
                scanCount += 1
                return restartedOriginalGetMessagesBeforeSeq(...args)
            }
            const restartedCache = new SessionCache(reopenedStore, createPublisher([]))
            restartedCache.reloadAll()

            expect(scanCount).toBe(1)
            expect(restartedCache.getSession(created.id)?.todos).toEqual([
                {
                    content: 'Persist this migration',
                    priority: 'medium',
                    status: 'in_progress',
                    id: 'plan-1'
                }
            ])
        } finally {
            reopenedStore.close()
        }
    })
})
