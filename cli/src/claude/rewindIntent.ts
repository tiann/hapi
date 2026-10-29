import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

const Intent = z.object({
    operationId: z.string().min(1),
    requestedLocalId: z.string().min(1),
    cutoffSeq: z.number().int().nonnegative(),
    phase: z.enum(['pending', 'applied']),
    hubSessionId: z.string(),
    nativeSessionId: z.string(),
    workingDirectory: z.string(),
    keepBoundary: z.string(),
    dropFromLocalId: z.string(),
    droppedPrompts: z.array(z.string()),
    baselineUuids: z.array(z.string())
})
export type RewindIntent = z.infer<typeof Intent>

/** A durable branch intent, scoped to both the hub and native identities.
 * Keep it until a real post-rewind turn is durable; process init is not a commit.
 * Parse and I/O failures deliberately propagate, rather than resuming the old tail.
 */
export class RewindIntentStore {
    private readonly directory: string
    private readonly file: string
    constructor(home: string, server: string, private readonly hubSessionId: string) {
        this.directory = join(home, 'claude-rewind-intents')
        const key = createHash('sha256').update(JSON.stringify([server, hubSessionId])).digest('hex')
        this.file = join(this.directory, `${key}.json`)
    }
    read(): RewindIntent | null {
        if (!existsSync(this.file)) return null
        const value = JSON.parse(readFileSync(this.file, 'utf8'))
        if (value === null) return null
        const intent = Intent.parse(value)
        if (intent.hubSessionId !== this.hubSessionId) throw new Error('Rewind intent identity mismatch')
        return intent
    }
    write(intent: RewindIntent | null): void {
        if (intent && intent.hubSessionId !== this.hubSessionId) throw new Error('Rewind intent identity mismatch')
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        const temporary = `${this.file}.${process.pid}.tmp`
        const fd = openSync(temporary, 'w', 0o600)
        try {
            writeFileSync(fd, JSON.stringify(intent))
            fsyncSync(fd)
        } finally { closeSync(fd) }
        renameSync(temporary, this.file)
        const dir = openSync(this.directory, 'r')
        try { fsyncSync(dir) } finally { closeSync(dir) }
    }
}
