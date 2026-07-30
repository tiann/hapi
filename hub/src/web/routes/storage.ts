import { stat } from 'node:fs/promises'
import type { SqliteStorageUsageResponse } from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'

async function fileSize(path: string, required = false): Promise<number> {
    try {
        return (await stat(path)).size
    } catch (error) {
        if (!required && error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
        throw error
    }
}

export function createStorageRoutes(dbPath: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/storage/sqlite', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Storage usage is only available to the hub owner' }, 403)
        }
        c.header('Cache-Control', 'no-store')
        try {
            const [databaseBytes, walBytes, shmBytes] = await Promise.all([
                fileSize(dbPath, true),
                fileSize(`${dbPath}-wal`),
                fileSize(`${dbPath}-shm`),
            ])
            const response: SqliteStorageUsageResponse = {
                path: dbPath,
                databaseBytes,
                walBytes,
                shmBytes,
                totalBytes: databaseBytes + walBytes + shmBytes,
            }
            return c.json(response)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to read SQLite storage usage'
            }, 500)
        }
    })

    return app
}
