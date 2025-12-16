import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { configuration } from '../configuration'

const jwtSecretFileSchema = z.object({
    secretBase64: z.string()
})

export async function getOrCreateJwtSecret(): Promise<Uint8Array> {
    const secretFile = join(configuration.dataDir, 'jwt-secret.json')

    if (existsSync(secretFile)) {
        await chmod(secretFile, 0o600).catch(() => {})
        const raw = await readFile(secretFile, 'utf8')
        const parsed = jwtSecretFileSchema.parse(JSON.parse(raw))
        const bytes = new Uint8Array(Buffer.from(parsed.secretBase64, 'base64'))
        if (bytes.length !== 32) {
            throw new Error(`Invalid JWT secret length in ${secretFile}`)
        }
        return bytes
    }

    const secretBytes = new Uint8Array(randomBytes(32))
    const dir = dirname(secretFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }

    const payload = {
        secretBase64: Buffer.from(secretBytes).toString('base64')
    }
    await writeFile(secretFile, JSON.stringify(payload, null, 4), { mode: 0o600 })
    await chmod(secretFile, 0o600).catch(() => {})

    return secretBytes
}
