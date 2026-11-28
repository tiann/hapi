import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
        }, 'kimi-k2.5')).toEqual({
            message: {
                type: 'token_count',
                model: 'kimi-k2.5',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'includes-cache',
                info: {
                    total: {
                        inputTokens: 160,
                        outputTokens: 20,
                        cachedInputTokens: 50,
                        cacheWriteInputTokens: 10
                    }
                }
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

    it('forwards events after a baseline offset without replaying older lines', async () => {
        const oldLine = JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'old' }],
            origin: { kind: 'user' }
        }) + '\n';
        const newLine = JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'confirming prompt' }],
            origin: { kind: 'user' }
        }) + '\n';
        await writeFile(wirePath, oldLine + newLine);
        const fileStats = await stat(wirePath);

        scanner = await createKimiWireScanner({
            wirePath,
            wireBaseline: { device: fileStats.dev, inode: fileStats.ino, offset: Buffer.byteLength(oldLine) },
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'confirming prompt' }]
        });
        await wait(300);
        expect(events).toHaveLength(1);
    });

    it('forwards the confirming events when the resume baseline was empty', async () => {
        await writeFile(wirePath, JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'first prompt' }],
            origin: { kind: 'user' }
        }) + '\n');
        const fileStats = await stat(wirePath);

        scanner = await createKimiWireScanner({
            wirePath,
            wireBaseline: { device: fileStats.dev, inode: fileStats.ino, offset: 0 },
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe('turn.prompt');
    });

    it('reads a replaced wire file from the start when the baseline inode changed', async () => {
        const firstLine = JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'first resumed turn' }],
            origin: { kind: 'user' }
        }) + '\n';
        const secondLine = JSON.stringify({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'second resumed turn' }],
            origin: { kind: 'user' }
        }) + '\n';
        await writeFile(wirePath, firstLine);
        const baselineStats = await stat(wirePath);
        const baseline = { device: baselineStats.dev, inode: baselineStats.ino, offset: baselineStats.size };

        // kimi-code replaces the journal before hapi attaches the scanner.
        const replacementPath = join(testDir, 'wire-replacement.jsonl');
        await writeFile(replacementPath, firstLine + secondLine);
        await rename(replacementPath, wirePath);

        const replacedStats = await stat(wirePath);
        expect(replacedStats.size).toBeGreaterThanOrEqual(baseline.offset);
        expect(replacedStats.ino).not.toBe(baseline.inode);

        scanner = await createKimiWireScanner({
            wirePath,
            wireBaseline: baseline,
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'first resumed turn' }]
        });
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
