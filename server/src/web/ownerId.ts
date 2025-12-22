import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { configuration } from '../configuration'

const ownerIdFileSchema = z.object({
    ownerId: z.number()
})

function generateOwnerId(): number {
    const bytes = randomBytes(6)
    let value = 0
    for (const byte of bytes) {
        value = (value << 8) + byte
    }
    return value > 0 ? value : 1
}

let cachedOwnerId: number | null = null

export async function getOrCreateOwnerId(): Promise<number> {
    if (cachedOwnerId !== null) {
        return cachedOwnerId
    }

    const ownerIdFile = join(configuration.dataDir, 'owner-id.json')

    if (existsSync(ownerIdFile)) {
        await chmod(ownerIdFile, 0o600).catch(() => {})
        const raw = await readFile(ownerIdFile, 'utf8')
        const parsed = ownerIdFileSchema.parse(JSON.parse(raw))
        if (!Number.isSafeInteger(parsed.ownerId) || parsed.ownerId <= 0) {
            throw new Error(`Invalid ownerId in ${ownerIdFile}`)
        }
        cachedOwnerId = parsed.ownerId
        return parsed.ownerId
    }

    const ownerId = generateOwnerId()
    const dir = dirname(ownerIdFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }

    const payload = { ownerId }
    await writeFile(ownerIdFile, JSON.stringify(payload, null, 4), { mode: 0o600 })
    await chmod(ownerIdFile, 0o600).catch(() => {})

    cachedOwnerId = ownerId
    return ownerId
}
