import { describe, expect, it } from 'vitest'
import { parsePiModelsProbeLine } from './piModels'

function probeResponseLine(data: unknown): string {
    return JSON.stringify({
        id: 'hapi-machine-models-probe',
        type: 'response',
        command: 'get_available_models',
        success: true,
        data,
    })
}

describe('parsePiModelsProbeLine', () => {
    it('parses the get_available_models response with full model records', () => {
        const models = parsePiModelsProbeLine(probeResponseLine({
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
        expect(models).toEqual([
            {
                provider: 'anthropic',
                modelId: 'claude-opus-5',
                name: 'Claude Opus 5',
                contextWindow: 200000,
                reasoning: true,
                thinkingLevelMap: { off: 'off', minimal: null, xhigh: 'xhigh', max: 'max' },
            },
            { provider: 'openai', modelId: 'gpt-4o', reasoning: false },
        ])
    })

    it('ignores non-JSON lines and unrelated RPC traffic', () => {
        expect(parsePiModelsProbeLine('starting up...')).toBeNull()
        expect(parsePiModelsProbeLine('')).toBeNull()
        expect(parsePiModelsProbeLine('{not json')).toBeNull()
        expect(parsePiModelsProbeLine(JSON.stringify({ type: 'event', event: 'agent_start' }))).toBeNull()
        expect(parsePiModelsProbeLine(JSON.stringify({
            id: 'x', type: 'response', command: 'get_state', success: true, data: {},
        }))).toBeNull()
    })

    it('treats a failed get_available_models response as no result', () => {
        expect(parsePiModelsProbeLine(JSON.stringify({
            id: 'x',
            type: 'response',
            command: 'get_available_models',
            success: false,
            error: 'boom',
        }))).toBeNull()
    })

    it('returns an empty catalog for a malformed data payload', () => {
        expect(parsePiModelsProbeLine(probeResponseLine('not-an-object'))).toEqual([])
        expect(parsePiModelsProbeLine(probeResponseLine({}))).toEqual([])
    })

    it('drops entries without an id but keeps the rest', () => {
        const models = parsePiModelsProbeLine(probeResponseLine({
            models: [
                { provider: 'openai' },
                { id: 'kept', provider: 'openai' },
            ],
        }))
        expect(models).toEqual([{ provider: 'openai', modelId: 'kept' }])
    })
})
