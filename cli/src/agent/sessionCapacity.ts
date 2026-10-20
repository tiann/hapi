import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'
import { configuration } from '@/configuration'
import { getProcessStartMarker, isProcessAlive } from '@/utils/process'
import { logger } from '@/ui/logger'

const LeaseSchema = z.object({
    pid: z.number().int().positive(),
    marker: z.string().min(1)
})

export function parseMaxLiveSessions(value: string | undefined): number {
    if (value === undefined) return 20
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('HAPI_MAX_LIVE_SESSIONS must be a non-negative integer (0 disables the limit)')
    }
    return Number(value)
}

/** One lease per HAPI root, including multiple roots hosted by the same PID. */
export async function acquireSessionSlot(): Promise<() => void> {
    const limit = parseMaxLiveSessions(process.env.HAPI_MAX_LIVE_SESSIONS)
    const directory = join(configuration.happyHomeDir, 'live-sessions')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, `${randomUUID()}.json`)
    await withSettingsFileLock(join(directory, 'admission'), async () => {
        let count = 0
        const generations = new Map<number, { alive: boolean; marker: string | null }>()
        for (const name of await readdir(directory)) {
            if (!name.endsWith('.json')) continue
            const path = join(directory, name)
            let lease: z.infer<typeof LeaseSchema>
            try {
                lease = LeaseSchema.parse(JSON.parse(await readFile(path, 'utf8')))
            } catch (error) {
                // A concurrent close may remove its lease without taking this lock.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw new Error(`Cannot verify live session lease ${path}`, { cause: error })
            }
            let generation = generations.get(lease.pid)
            if (!generation) {
                const alive = isProcessAlive(lease.pid)
                generation = { alive, marker: alive ? getProcessStartMarker(lease.pid) : null }
                generations.set(lease.pid, generation)
            }
            if (!generation.alive || (generation.marker !== null && generation.marker !== lease.marker)) {
                await unlink(path).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== 'ENOENT') throw error
                })
            } else {
                // An unavailable generation probe is not evidence of an exit.
                count++
            }
        }
        if (limit !== 0 && count >= limit) {
            throw new Error(`Live session limit reached (${count}/${limit}). Stop an existing session before starting or resuming another, or raise HAPI_MAX_LIVE_SESSIONS.`)
        }
        const marker = getProcessStartMarker(process.pid)
        if (!marker) throw new Error('Cannot verify this process generation for live session admission')
        const temporary = `${target}.tmp`
        await writeFile(temporary, JSON.stringify({ pid: process.pid, marker }), { mode: 0o600 })
        await rename(temporary, target)
    })
    return () => {
        try {
            // Synchronous removal lets an immediate close/reopen reuse the slot.
            unlinkSync(target)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.debug('[session capacity] Failed to release session slot', error)
            }
        }
    }
}

export function withSessionCapacity<T, R>(bootstrap: (options: T, releaseSlot: () => void) => Promise<R>): (options: T) => Promise<R> {
    return async options => {
        const releaseSlot = await acquireSessionSlot()
        try {
            return await bootstrap(options, releaseSlot)
        } catch (error) {
            releaseSlot()
            throw error
        }
    }
}
