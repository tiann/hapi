import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_PERMISSION_MODES } from '@hapi/protocol/modes'
import { isDeepStrictEqual } from 'node:util'

export const RewindDeliverySchema = z.object({
    deliveredText: z.string(),
    items: z.array(z.object({ message: z.string(), localId: z.string().optional(), internal: z.boolean().optional() })).min(1),
    isolate: z.boolean(),
    mode: z.object({
        permissionMode: z.enum(CLAUDE_PERMISSION_MODES), model: z.string().optional(), effort: z.string().optional(),
        fallbackModel: z.string().optional(), customSystemPrompt: z.string().optional(), appendSystemPrompt: z.string().optional(),
        allowedTools: z.array(z.string()).optional(), disallowedTools: z.array(z.string()).optional()
    })
})
export type RewindDelivery = z.infer<typeof RewindDeliverySchema>

const Intent = z.object({
    operationId: z.string().min(1),
    requestedLocalId: z.string().min(1),
    cutoffSeq: z.number().int().nonnegative(),
    phase: z.enum(['pending', 'applied']),
    stagedInput: z.object({ localIds: z.array(z.string()), textHash: z.string(), delivery: RewindDeliverySchema }).optional(),
    hubSessionId: z.string(),
    nativeSessionId: z.string(),
    workingDirectory: z.string(),
    keepBoundary: z.string(),
    dropFromLocalId: z.string(),
    droppedPrompts: z.array(z.string()),
    baselineUuids: z.array(z.string())
}).superRefine((intent, ctx) => {
    const input = intent.stagedInput
    if (input && (createHash('sha256').update(input.delivery.deliveredText).digest('hex') !== input.textHash
        || JSON.stringify(input.localIds) !== JSON.stringify(input.delivery.items.flatMap(item => item.localId ? [item.localId] : [])))) {
        ctx.addIssue({ code: 'custom', message: 'Rewind staged input identity mismatch' })
    }
})
export type RewindIntent = z.infer<typeof Intent>

/** An unresolved owner is immutable, including its execution settings. */
export function withStagedRewindInput(intent: RewindIntent, value: RewindDelivery): RewindIntent {
    const delivery = JSON.parse(JSON.stringify(RewindDeliverySchema.parse(value))) as RewindDelivery
    if (intent.stagedInput) {
        const prior = JSON.parse(JSON.stringify(intent.stagedInput.delivery))
        if (!isDeepStrictEqual(prior, delivery)) throw new Error('An unresolved rewind input cannot be replaced by a different batch')
        return intent
    }
    return {
        ...intent,
        stagedInput: {
            delivery, localIds: delivery.items.flatMap(item => item.localId ? [item.localId] : []),
            textHash: createHash('sha256').update(delivery.deliveredText).digest('hex')
        }
    }
}

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
        if (intent) Intent.parse(intent)
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
