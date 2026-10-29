import { expect, it } from 'bun:test'
import { MetadataSchema, ClaudeRewindSchema } from './schemas'

it('retains the durable rewind contract in metadata and rejects malformed cutoffs/phases', () => {
    const rewind = { operationId: 'op', phase: 'requested', requestedLocalId: 'boundary', cutoffSeq: 42 }
    expect(MetadataSchema.parse({ path: '/tmp', host: 'host', claudeRewind: rewind }).claudeRewind).toEqual(rewind)
    expect(ClaudeRewindSchema.safeParse({ ...rewind, cutoffSeq: -1 }).success).toBe(false)
    expect(ClaudeRewindSchema.safeParse({ ...rewind, phase: 'done' }).success).toBe(false)
})
