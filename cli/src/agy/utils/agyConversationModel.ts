import { homedir } from 'node:os'
import { join } from 'node:path'

const CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AgyConversationRow = {
    kind: 'step' | 'generation'
    idx: number
    data: unknown
}

type QueryConversationRows = (brainUuid: string) => Promise<AgyConversationRow[]>

function unknownModels(stepIndexes: readonly number[]): Map<number, string | null> {
    return new Map(stepIndexes.map((idx) => [idx, null]))
}

function asBytes(value: unknown): Uint8Array | null {
    if (typeof value === 'string') return Buffer.from(value)
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return null
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
    let value = 0
    let multiplier = 1
    for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
        const byte = bytes[offset]
        value += (byte & 0x7f) * multiplier
        if (!Number.isSafeInteger(value)) return null
        if ((byte & 0x80) === 0) return { value, next: offset + 1 }
        multiplier *= 128
    }
    return null
}

function readLengthDelimitedField(bytes: Uint8Array, wantedField: number): Uint8Array | null {
    let offset = 0
    let found: Uint8Array | null = null
    while (offset < bytes.length) {
        const tag = readVarint(bytes, offset)
        if (!tag || tag.value === 0) return null
        offset = tag.next
        const fieldNumber = Math.floor(tag.value / 8)
        const wireType = tag.value & 7

        if (wireType === 2) {
            const length = readVarint(bytes, offset)
            if (!length) return null
            const end = length.next + length.value
            if (!Number.isSafeInteger(end) || end > bytes.length) return null
            if (fieldNumber === wantedField) {
                if (found) return null
                found = bytes.subarray(length.next, end)
            }
            offset = end
        } else if (wireType === 0) {
            const value = readVarint(bytes, offset)
            if (!value) return null
            offset = value.next
        } else if (wireType === 1) {
            if (offset + 8 > bytes.length) return null
            offset += 8
        } else if (wireType === 5) {
            if (offset + 4 > bytes.length) return null
            offset += 4
        } else {
            return null
        }
    }
    return found
}

function decodeText(bytes: Uint8Array | null): string | null {
    if (!bytes) return null
    try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return value.length > 0 ? value : null
    } catch {
        return null
    }
}

function invocationFromStep(data: unknown): string | null {
    const bytes = asBytes(data)
    return bytes ? decodeText(readLengthDelimitedField(bytes, 12)) : null
}

function generationMetadata(data: unknown): { invocation: string; model: string | null } | null {
    const bytes = asBytes(data)
    if (!bytes) return null
    const invocation = decodeText(readLengthDelimitedField(bytes, 4))
    if (!invocation) return null
    const generation = readLengthDelimitedField(bytes, 1)
    const model = generation ? decodeText(readLengthDelimitedField(generation, 21)) : null
    return { invocation, model }
}

export function resolveAgyTurnModelsFromRows(
    stepIndexes: readonly number[],
    rows: readonly AgyConversationRow[],
): Map<number, string | null> {
    const result = unknownModels(stepIndexes)
    const requested = new Set(stepIndexes)
    const stepsByInvocation = new Map<string, number[]>()
    const generationsByInvocation = new Map<string, Array<{ idx: number; model: string | null }>>()

    for (const row of rows) {
        if (!Number.isSafeInteger(row.idx)) continue
        if (row.kind === 'step') {
            const invocation = invocationFromStep(row.data)
            if (!invocation) continue
            const steps = stepsByInvocation.get(invocation) ?? []
            steps.push(row.idx)
            stepsByInvocation.set(invocation, steps)
        } else if (row.kind === 'generation') {
            const metadata = generationMetadata(row.data)
            if (!metadata) continue
            const generations = generationsByInvocation.get(metadata.invocation) ?? []
            generations.push({ idx: row.idx, model: metadata.model })
            generationsByInvocation.set(metadata.invocation, generations)
        }
    }

    for (const [invocation, steps] of stepsByInvocation) {
        const generations = generationsByInvocation.get(invocation)
        if (!generations || steps.length !== generations.length) continue
        steps.sort((a, b) => a - b)
        generations.sort((a, b) => a.idx - b.idx)
        for (let ordinal = 0; ordinal < steps.length; ordinal++) {
            const stepIndex = steps[ordinal]
            if (requested.has(stepIndex)) result.set(stepIndex, generations[ordinal].model)
        }
    }
    return result
}

async function queryConversationRows(brainUuid: string): Promise<AgyConversationRow[]> {
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(CONVERSATIONS_DIR, `${brainUuid}.db`), { readonly: true })
    try {
        // One statement gives the scanner a single SQLite read snapshot for both
        // sides of the ordinal mapping and avoids one query per response.
        return db.query(`
            SELECT 'step' AS kind, idx, metadata AS data
            FROM steps
            WHERE step_type = 15
            UNION ALL
            SELECT 'generation' AS kind, idx, data
            FROM gen_metadata
        `).all() as AgyConversationRow[]
    } finally {
        db.close()
    }
}

/** Best-effort batch resolver. Database absence/locks/format drift never throw. */
export async function resolveAgyTurnModels(
    brainUuid: string | null | undefined,
    stepIndexes: readonly number[],
    queryRows: QueryConversationRows = queryConversationRows,
): Promise<Map<number, string | null>> {
    const unknown = unknownModels(stepIndexes)
    if (!brainUuid || !CANONICAL_UUID_RE.test(brainUuid) || stepIndexes.length === 0) return unknown
    try {
        return resolveAgyTurnModelsFromRows(stepIndexes, await queryRows(brainUuid))
    } catch {
        return unknown
    }
}
