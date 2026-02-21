import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'

import type { SetSessionSortPreferenceResult, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createPreferencesRoutes } from './preferences'

function createApp(options: {
    userId: number
    namespace: string
    engine: SyncEngine
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/api/*', async (c, next) => {
        c.set('userId', options.userId)
        c.set('namespace', options.namespace)
        await next()
    })

    app.route('/api', createPreferencesRoutes(() => options.engine))
    return app
}

describe('preferences routes', () => {
    it('GET returns sort preference for authenticated user and namespace', async () => {
        const captured: { userId?: number; namespace?: string } = {}
        const engine = {
            getSessionSortPreference: (userId: number, namespace: string) => {
                captured.userId = userId
                captured.namespace = namespace
                return {
                    sortMode: 'auto',
                    manualOrder: {
                        groupOrder: [],
                        sessionOrder: {}
                    },
                    version: 1,
                    updatedAt: 0
                }
            }
        } as unknown as SyncEngine

        const app = createApp({ userId: 7, namespace: 'alpha', engine })
        const response = await app.request('http://localhost/api/preferences/session-sort')

        expect(response.status).toBe(200)
        const json = await response.json() as {
            preference: {
                sortMode: string
                version: number
            }
        }
        expect(json.preference.sortMode).toBe('auto')
        expect(json.preference.version).toBe(1)
        expect(captured).toEqual({ userId: 7, namespace: 'alpha' })
    })

    it('PUT persists preference and returns updated snapshot', async () => {
        const engine = {
            setSessionSortPreference: () => ({
                result: 'success',
                preference: {
                    sortMode: 'manual',
                    manualOrder: {
                        groupOrder: ['m1::/repo/app'],
                        sessionOrder: {
                            'm1::/repo/app': ['session-1']
                        }
                    },
                    version: 2,
                    updatedAt: 100
                }
            } satisfies SetSessionSortPreferenceResult)
        } as unknown as SyncEngine

        const app = createApp({ userId: 9, namespace: 'beta', engine })

        const response = await app.request('http://localhost/api/preferences/session-sort', {
            method: 'PUT',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sortMode: 'manual',
                manualOrder: {
                    groupOrder: ['m1::/repo/app'],
                    sessionOrder: {
                        'm1::/repo/app': ['session-1']
                    }
                },
                expectedVersion: 1
            })
        })

        expect(response.status).toBe(200)
        const json = await response.json() as {
            preference: {
                sortMode: string
                version: number
            }
        }
        expect(json.preference.sortMode).toBe('manual')
        expect(json.preference.version).toBe(2)
    })

    it('PUT returns 409 and latest preference on version mismatch', async () => {
        const engine = {
            setSessionSortPreference: () => ({
                result: 'version-mismatch',
                preference: {
                    sortMode: 'manual',
                    manualOrder: {
                        groupOrder: ['m1::/repo/app'],
                        sessionOrder: {
                            'm1::/repo/app': ['session-1']
                        }
                    },
                    version: 3,
                    updatedAt: 200
                }
            } satisfies SetSessionSortPreferenceResult)
        } as unknown as SyncEngine

        const app = createApp({ userId: 1, namespace: 'alpha', engine })

        const response = await app.request('http://localhost/api/preferences/session-sort', {
            method: 'PUT',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sortMode: 'manual',
                manualOrder: {
                    groupOrder: [],
                    sessionOrder: {}
                },
                expectedVersion: 1
            })
        })

        expect(response.status).toBe(409)
        const json = await response.json() as {
            error: string
            preference: {
                version: number
            }
        }
        expect(json.error).toBe('version_mismatch')
        expect(json.preference.version).toBe(3)
    })

    it('PUT validates body', async () => {
        const engine = {
            setSessionSortPreference: () => ({ result: 'error' })
        } as unknown as SyncEngine
        const app = createApp({ userId: 1, namespace: 'alpha', engine })

        const response = await app.request('http://localhost/api/preferences/session-sort', {
            method: 'PUT',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sortMode: 'manual',
                expectedVersion: 0
            })
        })

        expect(response.status).toBe(400)
    })

    it('PUT uses auth scope from middleware', async () => {
        const captured: {
            userId?: number
            namespace?: string
        } = {}
        const engine = {
            setSessionSortPreference: (userId: number, namespace: string) => {
                captured.userId = userId
                captured.namespace = namespace
                return {
                    result: 'success',
                    preference: {
                        sortMode: 'auto',
                        manualOrder: {
                            groupOrder: [],
                            sessionOrder: {}
                        },
                        version: 2,
                        updatedAt: 0
                    }
                } satisfies SetSessionSortPreferenceResult
            }
        } as unknown as SyncEngine

        const app = createApp({ userId: 99, namespace: 'team-1', engine })

        const response = await app.request('http://localhost/api/preferences/session-sort', {
            method: 'PUT',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sortMode: 'auto',
                manualOrder: {
                    groupOrder: [],
                    sessionOrder: {}
                },
                expectedVersion: 1
            })
        })

        expect(response.status).toBe(200)
        expect(captured).toEqual({ userId: 99, namespace: 'team-1' })
    })
})
