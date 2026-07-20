import { describe, it, expect } from 'vitest';
import {
    parseOmpModels,
    parseOmpCommands,
    OmpStateDataSchema,
    OmpSetModelDataSchema,
    OmpAgentEventSchema,
    OmpResponseEventSchema,
    OmpSubagentLifecycleEventSchema,
    OmpSubagentProgressEventSchema,
} from './schemas';

describe('parseOmpModels', () => {
    it('extracts model from OMP Model shape with thinking.efforts/effortMap/defaultLevel', () => {
        const data = {
            models: [{
                id: 'glm-5.2',
                provider: 'local-openai',
                name: 'GLM 5.2',
                contextWindow: 1_000_000,
                reasoning: true,
                thinking: {
                    mode: 'effort',
                    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
                    effortMap: { minimal: 'none', low: 'high', xhigh: 'max' },
                    defaultLevel: 'xhigh',
                },
            }],
        };
        const models = parseOmpModels(data);
        expect(models).toHaveLength(1);
        expect(models[0]).toEqual({
            provider: 'local-openai',
            modelId: 'glm-5.2',
            name: 'GLM 5.2',
            contextWindow: 1_000_000,
            reasoning: true,
            efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
            effortMap: { minimal: 'none', low: 'high', xhigh: 'max' },
            defaultLevel: 'xhigh',
        });
    });

    it('drops model entries with empty id', () => {
        const data = { models: [{ id: '', provider: 'p' }, { id: 'ok', provider: 'p' }] };
        const models = parseOmpModels(data);
        expect(models).toHaveLength(1);
        expect(models[0].modelId).toBe('ok');
    });

    it('defaults provider to unknown when missing', () => {
        const models = parseOmpModels({ models: [{ id: 'm1' }] });
        expect(models[0].provider).toBe('unknown');
    });

    it('omits thinking fields when model has no thinking object', () => {
        const models = parseOmpModels({ models: [{ id: 'm1', provider: 'p', reasoning: false }] });
        expect(models[0].efforts).toBeUndefined();
        expect(models[0].effortMap).toBeUndefined();
        expect(models[0].defaultLevel).toBeUndefined();
    });

    it('fault-tolerates a non-object thinking field (does not drop the whole model)', () => {
        // OCR round 3: thinking field as a string must not reject the model entry.
        const models = parseOmpModels({ models: [{ id: 'm1', provider: 'p', thinking: 'high' }] });
        expect(models).toHaveLength(1);
        expect(models[0].modelId).toBe('m1');
        expect(models[0].efforts).toBeUndefined();
    });

    it('treats efforts as undefined when not a string array', () => {
        const models = parseOmpModels({
            models: [{ id: 'm1', provider: 'p', thinking: { efforts: 'high' } }],
        });
        expect(models[0].efforts).toBeUndefined();
    });

    it('returns empty array when models field is absent', () => {
        expect(parseOmpModels({})).toEqual([]);
    });

    it('fault-tolerates models field as a non-array (.catch fallback)', () => {
        // OCR round 5: .default([]) only covers undefined; a non-array value
        // must not crash. (Schema uses .default([]); parseOmpModels adds ?? [].)
        expect(parseOmpModels({ models: 'not-an-array' })).toEqual([]);
        expect(parseOmpModels({ models: null })).toEqual([]);
    });
});

describe('parseOmpCommands', () => {
    it('parses builtin source commands (OMP pushes built-in slash commands)', () => {
        const data = { commands: [{ name: 'compact', description: 'Compact', source: 'builtin' }] };
        const cmds = parseOmpCommands(data);
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toEqual({ name: 'compact', description: 'Compact', source: 'builtin' });
    });

    it('normalizes unknown source to builtin', () => {
        const cmds = parseOmpCommands({ commands: [{ name: 'x', source: 'weird' }] });
        expect(cmds[0].source).toBe('builtin');
    });

    it('drops entries with empty name', () => {
        const cmds = parseOmpCommands({ commands: [{ name: '', source: 'builtin' }, { name: 'ok' }] });
        expect(cmds).toHaveLength(1);
        expect(cmds[0].name).toBe('ok');
    });

    it('returns empty when commands absent or non-array', () => {
        expect(parseOmpCommands({})).toEqual([]);
        expect(parseOmpCommands({ commands: null })).toEqual([]);
    });
});

describe('OmpStateDataSchema', () => {
    it('parses get_state data including sessionFile + modes', () => {
        const parsed = OmpStateDataSchema.safeParse({
            model: { id: 'glm-5.2', provider: 'local-openai', thinking: { efforts: ['high'] } },
            sessionId: 'abc-123',
            sessionFile: '/path/to/session.jsonl',
            thinkingLevel: 'xhigh',
            steeringMode: 'all',
            followUpMode: 'one-at-a-time',
            interruptMode: 'wait',
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.sessionFile).toBe('/path/to/session.jsonl');
            expect(parsed.data.steeringMode).toBe('all');
            expect(parsed.data.interruptMode).toBe('wait');
        }
    });

    it('fault-tolerates invalid enum mode values via .catch(undefined)', () => {
        // OCR round 2: a future OMP mode value must not reject the whole state
        // (which would drop model/sessionId/thinkingLevel too).
        const parsed = OmpStateDataSchema.safeParse({
            sessionId: 'keep-me',
            steeringMode: 'future-mode',
            interruptMode: 'also-future',
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.sessionId).toBe('keep-me');
            expect(parsed.data.steeringMode).toBeUndefined();
            expect(parsed.data.interruptMode).toBeUndefined();
        }
    });

    it('fault-tolerates non-object model field via .catch(undefined)', () => {
        // OCR round 3: model as a string must not reject the whole state.
        const parsed = OmpStateDataSchema.safeParse({
            sessionId: 'keep-me',
            model: 'not-an-object',
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.sessionId).toBe('keep-me');
            expect(parsed.data.model).toBeUndefined();
        }
    });
});

describe('OmpSetModelDataSchema', () => {
    it('parses set_model response with id + provider', () => {
        const parsed = OmpSetModelDataSchema.safeParse({ id: 'glm-5.2', provider: 'local-openai' });
        expect(parsed.success).toBe(true);
    });
});

describe('OmpAgentEventSchema', () => {
    it('accepts any object with a string type', () => {
        expect(OmpAgentEventSchema.safeParse({ type: 'ready' }).success).toBe(true);
        expect(OmpAgentEventSchema.safeParse({ type: 'goal_updated', goal: null }).success).toBe(true);
    });
    it('rejects non-objects', () => {
        expect(OmpAgentEventSchema.safeParse('string').success).toBe(false);
        expect(OmpAgentEventSchema.safeParse(null).success).toBe(false);
    });
});

describe('OmpResponseEventSchema', () => {
    it('parses a well-formed response with id correlation', () => {
        const parsed = OmpResponseEventSchema.safeParse({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { sessionId: 'x' },
            id: '42',
        });
        expect(parsed.success).toBe(true);
    });
    it('rejects response missing command/success', () => {
        // OCR round 4: malformed responses must be rejected so the loop can
        // skip them instead of hanging the pending RPC.
        expect(OmpResponseEventSchema.safeParse({ type: 'response' }).success).toBe(false);
        expect(OmpResponseEventSchema.safeParse({ type: 'response', command: 'x' }).success).toBe(false);
    });
});

describe('OMP Subagent schemas', () => {
    it('bounds progress text and normalizes invalid counters', () => {
        const parsed = OmpSubagentProgressEventSchema.safeParse({
            type: 'subagent_progress',
            payload: {
                agent: 'explore',
                task: 'x'.repeat(9000),
                progress: {
                    id: 'child-1',
                    status: 'running',
                    description: 'd'.repeat(600),
                    currentToolArgs: 'a'.repeat(1200),
                    toolCount: -1,
                    requests: Number.POSITIVE_INFINITY,
                    tokens: 42,
                    durationMs: 10,
                },
            },
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.payload.task).toHaveLength(8192);
            expect(parsed.data.payload.progress.description).toHaveLength(512);
            expect(parsed.data.payload.progress.currentToolArgs).toHaveLength(1024);
            expect(parsed.data.payload.progress.toolCount).toBe(0);
            expect(parsed.data.payload.progress.requests).toBe(0);
        }
    });

    it('rejects invalid lifecycle ids and future statuses', () => {
        expect(OmpSubagentLifecycleEventSchema.safeParse({
            type: 'subagent_lifecycle',
            payload: { id: '', status: 'started' },
        }).success).toBe(false);
        expect(OmpSubagentLifecycleEventSchema.safeParse({
            type: 'subagent_lifecycle',
            payload: { id: 'child-1', status: 'paused' },
        }).success).toBe(false);
    });
});
