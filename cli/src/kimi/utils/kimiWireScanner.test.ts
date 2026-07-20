import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertKimiWireEvent, createKimiWireScanner, type KimiWireScanner } from './kimiWireScanner';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('convertKimiWireEvent', () => {
    it('converts user prompts and steers', () => {
        expect(convertKimiWireEvent({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'hello' }],
            origin: { kind: 'user' },
            time: 1
        })).toEqual({ userMessage: 'hello' });

        expect(convertKimiWireEvent({
            type: 'turn.steer',
            input: [{ type: 'text', text: 'focus now' }],
            origin: { kind: 'user' }
        })).toEqual({ userMessage: 'focus now' });
    });

    it('ignores non-user prompts and unrelated records', () => {
        expect(convertKimiWireEvent({ type: 'turn.prompt', input: [{ type: 'text', text: 'x' }], origin: { kind: 'system' } })).toBeNull();
        expect(convertKimiWireEvent({ type: 'metadata', protocol_version: '1.4', created_at: 1 })).toBeNull();
        expect(convertKimiWireEvent({ type: 'config.update', systemPrompt: '...' })).toBeNull();
        expect(convertKimiWireEvent({ type: 'llm.request', kind: 'loop' })).toBeNull();
        expect(convertKimiWireEvent({ type: 'usage.record', usage: {} })).toBeNull();
        expect(convertKimiWireEvent({ type: 'context.append_message', message: { role: 'user', content: [] } })).toBeNull();
    });

    it('converts assistant text and thinking parts', () => {
        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: { type: 'content.part', uuid: 'u1', part: { type: 'text', text: 'answer' } }
        })).toEqual({ message: { type: 'message', message: 'answer' } });

        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: { type: 'content.part', uuid: 'u2', part: { type: 'think', think: 'hmm' } }
        })).toEqual({ message: { type: 'reasoning', message: 'hmm', id: 'u2' } });
    });

    it('converts tool calls and results', () => {
        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: { type: 'tool.call', uuid: 'tool_1', toolCallId: 'tool_1', name: 'Grep', args: { pattern: 'kimi' } }
        })).toEqual({
            message: { type: 'tool-call', name: 'Grep', callId: 'tool_1', input: { pattern: 'kimi' } }
        });

        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: { type: 'tool.result', parentUuid: 'tool_1', toolCallId: 'tool_1', result: { output: 'matches' } }
        })).toEqual({
            message: { type: 'tool-call-result', callId: 'tool_1', output: 'matches' }
        });
    });

    it('forwards tool failure status as is_error', () => {
        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: { type: 'tool.result', parentUuid: 'tool_2', toolCallId: 'tool_2', result: { output: 'boom', isError: true } }
        })).toEqual({
            message: { type: 'tool-call-result', callId: 'tool_2', output: 'boom', is_error: true }
        });
    });

    it('converts step.end usage into token_count with cached input included', () => {
        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: {
                type: 'step.end',
                uuid: 's1',
                usage: { inputOther: 100, output: 20, inputCacheRead: 50, inputCacheCreation: 10 }
            }
        })).toEqual({
            message: {
                type: 'token_count',
                info: { total: { inputTokens: 160, outputTokens: 20, cachedInputTokens: 50 } }
            }
        });
    });

    it('ignores step.begin and unknown loop events', () => {
        expect(convertKimiWireEvent({
            type: 'context.append_loop_event',
            event: { type: 'step.begin', uuid: 's0', step: 1 }
        })).toBeNull();
    });
});

describe('kimiWireScanner', () => {
    let testDir: string;
    let wirePath: string;
    let scanner: KimiWireScanner | null = null;
    let events: { type: string }[] = [];

    beforeEach(async () => {
        testDir = join(tmpdir(), `kimi-wire-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(testDir, { recursive: true });
        wirePath = join(testDir, 'wire.jsonl');
        events = [];
    });

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }
        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('primes to EOF on attach and only emits new events', async () => {
        await writeFile(
            wirePath,
            [
                JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 }),
                JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'old' }], origin: { kind: 'user' } })
            ].join('\n') + '\n'
        );

        scanner = await createKimiWireScanner({
            wirePath,
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(0);

        await appendFile(
            wirePath,
            JSON.stringify({
                type: 'context.append_loop_event',
                event: { type: 'content.part', uuid: 'u1', part: { type: 'text', text: 'new answer' } }
            }) + '\n'
        );

        await wait(700);
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe('context.append_loop_event');
    });

    it('handles lines split across reads', async () => {
        await writeFile(wirePath, '');
        scanner = await createKimiWireScanner({
            wirePath,
            onEvent: (event) => events.push(event)
        });

        const line = JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'hi' }], origin: { kind: 'user' } });
        await appendFile(wirePath, line.slice(0, 30));
        await wait(300);
        expect(events).toHaveLength(0);

        await appendFile(wirePath, line.slice(30) + '\n');
        await wait(700);
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe('turn.prompt');
    });
});
