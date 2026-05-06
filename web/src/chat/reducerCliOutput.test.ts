import { describe, it, expect } from 'vitest'
import { mergeCliOutputBlocks, createCliOutputBlock } from './reducerCliOutput'
import type { CliOutputBlock } from './types'

function makeBlock(props: Partial<CliOutputBlock> & Pick<CliOutputBlock, 'id' | 'text'>): CliOutputBlock {
    return createCliOutputBlock({
        id: props.id,
        localId: props.localId ?? null,
        createdAt: props.createdAt ?? 0,
        invokedAt: props.invokedAt,
        usage: props.usage,
        model: props.model,
        text: props.text,
        source: props.source ?? 'assistant',
        meta: props.meta
    })
}

describe('mergeCliOutputBlocks', () => {
    it('prefers the command-name block (prev) metadata over the stdout follow-up (block)', () => {
        // The command-name block originated from the assistant message and
        // carries the real metadata. The stdout follow-up is a synthetic
        // split with no first-class metadata. The merge must keep prev's
        // values for every metadata field; block only fills in fields that
        // prev does not have.
        const prev = makeBlock({
            id: 'msg:0',
            text: '<command-name>foo</command-name>',
            invokedAt: 1000,
            usage: { input_tokens: 1, output_tokens: 2 },
            model: 'claude-sonnet-4-6'
        })
        prev.durationMs = 500

        const stdoutBlock = makeBlock({
            id: 'msg:1',
            text: '<local-command-stdout>bar</local-command-stdout>',
            invokedAt: 2000, // would be wrong if it overrode prev
            usage: { input_tokens: 99, output_tokens: 99 },
            model: 'wrong-model'
        })
        stdoutBlock.durationMs = 9999

        const [merged] = mergeCliOutputBlocks([prev, stdoutBlock])
        if (merged.kind !== 'cli-output') throw new Error('expected cli-output')
        expect(merged.invokedAt).toBe(1000)
        expect(merged.durationMs).toBe(500)
        expect(merged.usage).toEqual({ input_tokens: 1, output_tokens: 2 })
        expect(merged.model).toBe('claude-sonnet-4-6')
        expect(merged.text).toContain('<command-name>foo</command-name>')
        expect(merged.text).toContain('<local-command-stdout>bar</local-command-stdout>')
    })

    it('falls back to block metadata when prev does not have the field', () => {
        const prev = makeBlock({
            id: 'msg:0',
            text: '<command-name>foo</command-name>'
            // no metadata on prev
        })

        const stdoutBlock = makeBlock({
            id: 'msg:1',
            text: '<local-command-stdout>bar</local-command-stdout>',
            invokedAt: 2000,
            usage: { input_tokens: 5, output_tokens: 6 },
            model: 'fallback-model'
        })
        stdoutBlock.durationMs = 750

        const [merged] = mergeCliOutputBlocks([prev, stdoutBlock])
        if (merged.kind !== 'cli-output') throw new Error('expected cli-output')
        expect(merged.invokedAt).toBe(2000)
        expect(merged.durationMs).toBe(750)
        expect(merged.usage).toEqual({ input_tokens: 5, output_tokens: 6 })
        expect(merged.model).toBe('fallback-model')
    })
})
