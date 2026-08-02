import { describe, expect, it, vi } from 'vitest'
import { resolveAgyTurnModels, resolveAgyTurnModelsFromRows } from './agyConversationModel'

function varint(value: number): Buffer {
    const bytes: number[] = []
    do {
        let byte = value & 0x7f
        value >>>= 7
        if (value) byte |= 0x80
        bytes.push(byte)
    } while (value)
    return Buffer.from(bytes)
}

function field(number: number, value: Uint8Array | string): Buffer {
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    return Buffer.concat([varint((number << 3) | 2), varint(data.length), data])
}

function step(idx: number, invocation: string, metadata = field(12, invocation)) {
    return { kind: 'step' as const, idx, data: metadata }
}

function generation(idx: number, invocation: string, model: string, data = Buffer.concat([
    field(1, field(21, model)),
    field(4, invocation),
])) {
    return { kind: 'generation' as const, idx, data }
}

describe('resolveAgyTurnModelsFromRows', () => {
    it('reads the verified metadata.field12 and data.field4/data.field1.field21 wire paths', () => {
        const rows = [
            step(7, 'inv-a'),
            generation(30, 'inv-a', 'Gemini 3.5 Flash (Medium)'),
        ]

        expect(resolveAgyTurnModelsFromRows([7], rows)).toEqual(new Map([
            [7, 'Gemini 3.5 Flash (Medium)'],
        ]))
    })

    it('maps model switches across invocations instead of applying the latest generation to both', () => {
        const rows = [
            step(10, 'inv-old'),
            step(20, 'inv-new'),
            generation(100, 'inv-old', 'Claude Sonnet 4.6 (Thinking)'),
            generation(200, 'inv-new', 'Gemini 3.5 Pro (High)'),
        ]

        expect(resolveAgyTurnModelsFromRows([10, 20], rows)).toEqual(new Map([
            [10, 'Claude Sonnet 4.6 (Thinking)'],
            [20, 'Gemini 3.5 Pro (High)'],
        ]))
    })

    it('matches multiple generations in one invocation by ascending idx ordinal', () => {
        const rows = [
            step(40, 'inv-a'),
            step(20, 'inv-a'),
            generation(9, 'inv-a', 'second'),
            generation(3, 'inv-a', 'first'),
        ]

        expect(resolveAgyTurnModelsFromRows([40, 20], rows)).toEqual(new Map([
            [40, 'second'],
            [20, 'first'],
        ]))
    })

    it('does not guess when metadata is missing or invocation cardinality differs', () => {
        const rows = [
            { kind: 'step' as const, idx: 5, data: Buffer.alloc(0) },
            step(10, 'mismatch'),
            step(11, 'mismatch'),
            generation(30, 'mismatch', 'latest'),
        ]

        expect(resolveAgyTurnModelsFromRows([5, 10, 11], rows)).toEqual(new Map([
            [5, null],
            [10, null],
            [11, null],
        ]))
    })

    it('treats malformed and truncated protobuf as unknown without throwing', () => {
        const truncatedLength = Buffer.from([(12 << 3) | 2, 10, 0x61])
        const overflowingVarint = Buffer.from(Array(11).fill(0x80))
        const rows = [
            step(1, 'unused', truncatedLength),
            step(2, 'unused', overflowingVarint),
        ]

        expect(resolveAgyTurnModelsFromRows([1, 2], rows)).toEqual(new Map([
            [1, null],
            [2, null],
        ]))
    })
})

describe('resolveAgyTurnModels', () => {
    it('reads all rows through one batch query', async () => {
        const queryRows = vi.fn(async () => [
            step(1, 'inv-a'),
            generation(1, 'inv-a', 'model-a'),
        ])

        await expect(resolveAgyTurnModels('00000000-0000-4000-8000-000000000001', [1], queryRows)).resolves.toEqual(new Map([[1, 'model-a']]))
        expect(queryRows).toHaveBeenCalledTimes(1)
        expect(queryRows).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    })

    it('returns unknown models when the database read fails', async () => {
        const queryRows = vi.fn(async () => { throw new Error('database is locked') })

        await expect(resolveAgyTurnModels('00000000-0000-4000-8000-000000000001', [1, 2], queryRows)).resolves.toEqual(new Map([
            [1, null],
            [2, null],
        ]))
    })

    it('rejects path traversal before invoking the database reader', async () => {
        const queryRows = vi.fn(async () => [])

        await expect(resolveAgyTurnModels('../../conversations/other', [1], queryRows)).resolves.toEqual(new Map([[1, null]]))
        expect(queryRows).not.toHaveBeenCalled()
    })
})
