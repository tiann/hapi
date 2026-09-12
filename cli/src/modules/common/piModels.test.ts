import { describe, expect, it } from 'vitest'
import { parsePiModelsProbeLine } from './piModels'

const PROBE_RPC_ID = 'hapi-machine-models-probe'

function probeResponseLine(data: unknown): string {
    return JSON.stringify({
        id: PROBE_RPC_ID,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data,
    })
}

describe('parsePiModelsProbeLine', () => {
    it('parses the get_available_models response with full model records', () => {
        const result = parsePiModelsProbeLine(probeResponseLine({
            models: [
                {
                    id: 'claude-opus-5',
                    provider: 'anthropic',
                    name: 'Claude Opus 5',
                    contextWindow: 200000,
                    reasoning: true,
                    thinkingLevelMap: { off: 'off', minimal: null, xhigh: 'xhigh', max: 'max' },
                },
                { id: 'gpt-4o', provider: 'openai', reasoning: false },
            ],
        }))
        expect(result).toEqual({
            kind: 'models',
            models: [
                {
                    provider: 'anthropic',
                    modelId: 'claude-opus-5',
                    name: 'Claude Opus 5',
                    contextWindow: 200000,
                    reasoning: true,
                    thinkingLevelMap: { off: 'off', minimal: null, xhigh: 'xhigh', max: 'max' },
                },
                { provider: 'openai', modelId: 'gpt-4o', reasoning: false },
            ],
        })
    })

    it('ignores non-JSON lines and unrelated RPC traffic', () => {
        expect(parsePiModelsProbeLine('starting up...')).toBeNull()
        expect(parsePiModelsProbeLine('')).toBeNull()
        expect(parsePiModelsProbeLine('{not json')).toBeNull()
        expect(parsePiModelsProbeLine(JSON.stringify({ type: 'event', event: 'agent_start' }))).toBeNull()
        expect(parsePiModelsProbeLine(JSON.stringify({
            id: PROBE_RPC_ID, type: 'response', command: 'get_state', success: true, data: {},
        }))).toBeNull()
    })

    it('ignores a get_available_models response addressed to another request id', () => {
        expect(parsePiModelsProbeLine(JSON.stringify({
            id: 'someone-else',
            type: 'response',
            command: 'get_available_models',
            success: true,
            data: { models: [{ id: 'm', provider: 'p' }] },
        }))).toBeNull()
    })

    it('surfaces an explicit RPC failure with its error text', () => {
        expect(parsePiModelsProbeLine(JSON.stringify({
            id: PROBE_RPC_ID,
            type: 'response',
            command: 'get_available_models',
            success: false,
            error: 'Unknown command',
        }))).toEqual({ kind: 'error', error: 'Unknown command' })
    })

    it('falls back to a generic message when the failure carries no error text', () => {
        expect(parsePiModelsProbeLine(JSON.stringify({
            id: PROBE_RPC_ID,
            type: 'response',
            command: 'get_available_models',
            success: false,
        }))).toEqual({ kind: 'error', error: 'Pi rejected the model probe request' })
    })

    it('returns an empty catalog for a malformed data payload', () => {
        expect(parsePiModelsProbeLine(probeResponseLine('not-an-object'))).toEqual({ kind: 'models', models: [] })
        expect(parsePiModelsProbeLine(probeResponseLine({}))).toEqual({ kind: 'models', models: [] })
    })

    it('drops entries without an id but keeps the rest', () => {
        expect(parsePiModelsProbeLine(probeResponseLine({
            models: [
                { provider: 'openai' },
                { id: 'kept', provider: 'openai' },
            ],
        }))).toEqual({ kind: 'models', models: [{ provider: 'openai', modelId: 'kept' }] })
    })
})
