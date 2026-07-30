import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createStorageRoutes } from './storage'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('GET /api/storage/sqlite', () => {
    function createApp(dbPath: string, namespace = 'default') {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', namespace)
            await next()
        })
        app.route('/api', createStorageRoutes(dbPath))
        return app
    }

    it('returns the database and existing sidecar sizes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-storage-'))
        directories.push(directory)
        const dbPath = join(directory, 'hapi.db')
        await Promise.all([
            writeFile(dbPath, Buffer.alloc(10)),
            writeFile(`${dbPath}-wal`, Buffer.alloc(20)),
        ])
        const app = createApp(dbPath)

        const response = await app.request('/api/storage/sqlite')

        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({
            path: dbPath,
            databaseBytes: 10,
            walBytes: 20,
            shmBytes: 0,
            totalBytes: 30,
        })
    })

    it('rejects non-default namespaces', async () => {
        const response = await createApp('/unused/hapi.db', 'tenant').request('/api/storage/sqlite')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Storage usage is only available to the hub owner' })
    })
})
