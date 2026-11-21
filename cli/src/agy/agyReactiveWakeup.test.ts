import { EventEmitter } from 'node:events';
import { watch, type FSWatcher, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage, PermissionRequest, PromptContent } from '@/agent/types';
import { AcpSdkBackend } from '@/agent/backends/acp';
import { RPC_METHODS } from '@hapi/protocol';
import { AgySession } from './session';
import type { AgyMode } from './types';
import { AgyAcpRemoteLauncher } from './agyAcpRemoteLauncher';
import {
    AGY_WAKEUP_CONTINUE_PROMPT,
    advanceAgyTurnTranscriptCursor,
    agyTranscriptPaths,
    convertAgyReactiveSteps,
    decodeAgyTranscriptArgs,
    inspectAgyReactiveSteps,
    readAgyTranscriptStepsAfter,
    readLatestAgyTranscriptStepIndex,
    resolveAgyBackgroundTaskIds,
    supportsAgyLiveIdleWakeups,
    type AgyOpenBackgroundCommand,
    type AgyReactiveTimingConfig,
    type AgyTranscriptStep
} from './agyReactiveWakeup';

vi.mock('node:fs', async (load) => {
    const fs = await load<typeof import('node:fs')>();
    return { ...fs, watch: vi.fn(fs.watch) };
});
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const TIMINGS: AgyReactiveTimingConfig = {
    settleMs: 50,
    toolParkMs: 200,
    slowToolParkMs: 1_000,
    maxIdleMs: 5_000
};

function writeTranscript(
    brainDir: string,
    sessionId: string,
    compactLines: Array<Record<string, unknown> | string>,
    fullLines: Array<Record<string, unknown>> = []
): { compactPath: string; fullPath: string } {
    const paths = agyTranscriptPaths(brainDir, sessionId)!;
    mkdirSync(paths.logsDir, { recursive: true });
    const compactPayload = compactLines
        .map((entry) => typeof entry === 'string' ? entry : `${JSON.stringify(entry)}\n`)
        .join('');
    writeFileSync(paths.compactPath, compactPayload, 'utf8');
    if (fullLines.length > 0) {
        writeFileSync(
            paths.fullPath,
            fullLines.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
            'utf8'
        );
    }
    return { compactPath: paths.compactPath, fullPath: paths.fullPath };
}

class WakeupTestBackend {
    readonly prompts: PromptContent[][] = [];
    readonly resumeCalls: string[] = [];
    readonly cancelCalls: string[] = [];
    readonly setModeCalls: string[] = [];
    readonly permissionResponses: unknown[] = [];
    promptScripts: Array<(onUpdate: (message: AgentMessage) => void) => Promise<void>> = [];
    permissionHandler: ((request: PermissionRequest) => void) | null = null;
    currentModelId = 'gemini-4-argon-medium';
    promptInFlight = false;
    alive = true;
    sessionIdToCreate = 'agy-conv-wakeup';

    async initialize(): Promise<void> {}
    isTransportAlive(): boolean {
        return this.alive;
    }
    agentVersion: string | null = null;
    getAgentVersion(): string | null {
        return this.agentVersion;
    }
    async flushPendingMessageBuffers(): Promise<void> {}
    supportsSessionResume(): boolean {
        return true;
    }
    async newSession(): Promise<string> {
        return this.sessionIdToCreate;
    }
    async resumeSession(config: { sessionId: string }): Promise<string> {
        this.resumeCalls.push(config.sessionId);
        return config.sessionId;
    }
    getSessionModelsMetadata() {
        return { availableModels: [], currentModelId: this.currentModelId };
    }
    async setMode(_sessionId: string, modeId: string): Promise<void> {
        this.setModeCalls.push(modeId);
    }
    async setModel(_sessionId: string, modelId: string): Promise<void> {
        this.currentModelId = modelId;
    }
    isPromptRequestInFlight(): boolean {
        return this.promptInFlight;
    }
    async prompt(
        _sessionId: string,
        content: PromptContent[],
        onUpdate: (message: AgentMessage) => void,
        timing?: { onSent?: () => void; onAnswered?: () => void }
    ): Promise<void> {
        this.prompts.push(content);
        this.promptInFlight = true;
        timing?.onSent?.();
        try {
            const script = this.promptScripts.shift();
            if (script) {
                await script(onUpdate);
            } else {
                onUpdate({ type: 'text', text: 'ok' });
                onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            }
        } finally {
            this.promptInFlight = false;
            timing?.onAnswered?.();
        }
    }
    async cancelPrompt(sessionId: string): Promise<void> {
        this.cancelCalls.push(sessionId);
    }
    beginSoftSteerPrompt(): never {
        throw new Error('not used');
    }
    abortSoftSteers(): void {}
    async refreshSessionInfo(): Promise<void> {}
    setSessionInfoUpdateListener(): void {}
    setUserMessageChunkListener(): void {}
    onStderrError(): void {}
    onFormElicitation(): void {}
    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }
    async respondToPermission(_sessionId: string, _request: PermissionRequest, response: unknown): Promise<void> {
        this.permissionResponses.push(response);
    }
    async disconnect(): Promise<void> {
        this.alive = false;
    }
}

function makeHarness(permissionMode: AgyMode['permissionMode'] = 'always-proceed', sessionId: string | null = null) {
    const queue = new MessageQueue2<AgyMode>((mode) => hashObject(mode));
    const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
    const client = {
        sessionId: 'hapi-session',
        rpcHandlerManager: {
            handlers,
            registerHandler: vi.fn((method: string, handler: (payload?: unknown) => Promise<unknown>) => {
                handlers.set(method, handler);
            }),
            unregisterHandler: vi.fn()
        },
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitSteerIndeterminate: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        getMetadata: vi.fn(() => null),
        keepAlive: vi.fn(),
        emitSessionReady: vi.fn()
    };
    const session = new AgySession({
        api: {} as never,
        client: client as unknown as ApiSessionClient,
        path: '/srv/work/projects',
        logPath: '/tmp/agy-wakeup.log',
        sessionId,
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        permissionMode
    });
    return { session, queue, client };
}

describe('agyReactiveWakeup pure helpers', () => {
    let tempBrainDir: string;

    beforeEach(() => {
        tempBrainDir = mkdtempSync(join(tmpdir(), 'agy-reactive-test-'));
    });

    afterEach(() => {
        rmSync(tempBrainDir, { recursive: true, force: true });
    });

    it('rejects unsafe session segments and decodes JSON-serialized transcript args', () => {
        expect(agyTranscriptPaths(tempBrainDir, '../escape')).toBeNull();
        expect(agyTranscriptPaths(tempBrainDir, 'a/b')).toBeNull();
        expect(decodeAgyTranscriptArgs({
            Path: '"/srv/work/projects/a.ts"',
            StartLine: '10',
            Overwrite: 'false',
            Plain: 'raw-string'
        })).toEqual({
            Path: '/srv/work/projects/a.ts',
            StartLine: 10,
            Overwrite: false,
            Plain: 'raw-string'
        });
    });

    it('ignores incomplete trailing JSONL lines and upgrades truncated steps from transcript_full.jsonl', () => {
        writeTranscript(
            tempBrainDir,
            'conv-1',
            [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' },
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'short...',
                    truncated_fields: ['content']
                },
                '{"step_index":2,"source":"SYSTEM","type":"SYSTEM_MESSAGE"'
            ],
            [
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'full untruncated response text'
                }
            ]
        );

        expect(readLatestAgyTranscriptStepIndex(tempBrainDir, 'conv-1')).toBe(1);
        const steps = readAgyTranscriptStepsAfter(tempBrainDir, 'conv-1', 0);
        expect(steps).toHaveLength(1);
        expect(steps[0]?.content).toBe('full untruncated response text');
    });

    it('classifies completed wakeups vs gated tool parks vs in-workspace read_file waits', () => {
        const systemStep: AgyTranscriptStep = {
            step_index: 4,
            source: 'SYSTEM',
            type: 'SYSTEM_MESSAGE',
            status: 'DONE',
            content: '<SYSTEM_MESSAGE>Subagent done</SYSTEM_MESSAGE>'
        };

        // No SYSTEM_MESSAGE -> none.
        expect(inspectAgyReactiveSteps(
            [{ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' }],
            '/srv/work/projects',
            1_000,
            0,
            TIMINGS
        )).toEqual({ state: 'none' });

        // Final PLANNER_RESPONSE with no tool calls -> running before settleMs, completed after settleMs.
        const finalTextSteps: AgyTranscriptStep[] = [
            systemStep,
            { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'All done.' }
        ];
        expect(inspectAgyReactiveSteps(finalTextSteps, '/srv/work/projects', 120, 100, TIMINGS))
            .toEqual({ state: 'running', latestStepIndex: 5 });
        expect(inspectAgyReactiveSteps(finalTextSteps, '/srv/work/projects', 160, 100, TIMINGS))
            .toMatchObject({ state: 'completed', latestStepIndex: 5 });

        // Gated run_command -> parked_on_tool once toolParkMs elapses.
        const gatedCommandSteps: AgyTranscriptStep[] = [
            systemStep,
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'run_command', args: { CommandLine: '"git status"' } }]
            }
        ];
        expect(inspectAgyReactiveSteps(gatedCommandSteps, '/srv/work/projects', 200, 100, TIMINGS))
            .toEqual({ state: 'running', latestStepIndex: 5 });
        expect(inspectAgyReactiveSteps(gatedCommandSteps, '/srv/work/projects', 310, 100, TIMINGS))
            .toEqual({ state: 'parked_on_tool', latestStepIndex: 5 });

        // In-workspace read_file waits for slowToolParkMs, while outside-workspace read_file parks at toolParkMs.
        const inWorkspaceRead: AgyTranscriptStep[] = [
            systemStep,
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'read_file', args: { Path: '"/srv/work/projects/README.md"' } }]
            }
        ];
        const outWorkspaceRead: AgyTranscriptStep[] = [
            systemStep,
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'read_file', args: { Path: '"/etc/hosts"' } }]
            }
        ];
        expect(inspectAgyReactiveSteps(inWorkspaceRead, '/srv/work/projects', 400, 100, TIMINGS))
            .toEqual({ state: 'running', latestStepIndex: 5 });
        expect(inspectAgyReactiveSteps(outWorkspaceRead, '/srv/work/projects', 400, 100, TIMINGS))
            .toEqual({ state: 'parked_on_tool', latestStepIndex: 5 });

        // Partially completed mixed batch: allowed read_file finishes (step 6 READ_FILE DONE),
        // while second tool call (gated run_command) waits on permission.
        const mixedBatch: AgyTranscriptStep[] = [
            systemStep,
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                    { name: 'read_file', args: { Path: '"/srv/work/projects/README.md"' } },
                    { name: 'run_command', args: { CommandLine: '"git status"' } }
                ]
            },
            {
                step_index: 6,
                source: 'MODEL',
                type: 'READ_FILE',
                status: 'DONE',
                content: '1: # readme'
            }
        ];
        expect(inspectAgyReactiveSteps(mixedBatch, '/srv/work/projects', 200, 100, TIMINGS))
            .toEqual({ state: 'running', latestStepIndex: 6 });
        expect(inspectAgyReactiveSteps(mixedBatch, '/srv/work/projects', 310, 100, TIMINGS))
            .toEqual({ state: 'parked_on_tool', latestStepIndex: 6 });

        // Non-gated internal tools (read_board, post_message, run_workflow, etc.)
        // never park on tool permission even past slowToolParkMs, and a wakeup
        // ending with a completed swarm_wait step settles as completed without
        // waiting for a follow-up PLANNER_RESPONSE.
        const internalRunning: AgyTranscriptStep[] = [
            systemStep,
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'read_board', args: { since: '1' } }]
            }
        ];
        expect(inspectAgyReactiveSteps(internalRunning, '/srv/work/projects', 2_000, 100, TIMINGS))
            .toEqual({ state: 'running', latestStepIndex: 5 });

        const swarmWaitWakeup: AgyTranscriptStep[] = [
            systemStep,
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                    { name: 'post_message', args: { text: '"@worker1 next step"' } },
                    { name: 'swarm_wait', args: { since: '2' } }
                ]
            },
            {
                step_index: 6,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'DONE',
                content: '{"status":"posted","seq":3}'
            },
            {
                step_index: 7,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'DONE',
                content: 'Waiting for a message that calls on you by name, or on @all posted after #2.'
            }
        ];
        expect(inspectAgyReactiveSteps(swarmWaitWakeup, '/srv/work/projects', 120, 100, TIMINGS))
            .toEqual({ state: 'running', latestStepIndex: 7 });
        expect(inspectAgyReactiveSteps(swarmWaitWakeup, '/srv/work/projects', 160, 100, TIMINGS))
            .toMatchObject({ state: 'completed', latestStepIndex: 7 });
    });

    it('converts background task completion, allowed tool calls, reasoning, text, and usage', () => {
        const bgCommands: AgyOpenBackgroundCommand[] = [{ callId: 'call-bg-42', taskId: 'conv-xyz/task-7' }];
        const converted = convertAgyReactiveSteps('conv-xyz', [
            {
                step_index: 10,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                created_at: '2026-11-11T12:00:00Z',
                content: '<SYSTEM_MESSAGE>\nTask id "conv-xyz/task-7" finished with result:\nCommand exited with code 0.\n\nCommand output:\nBUILD_OK\nLog: file:///tmp/task-7.log\n</SYSTEM_MESSAGE>'
            },
            {
                step_index: 11,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-11T12:00:02Z',
                thinking: 'Checking output file',
                input_tokens: 100,
                output_tokens: 30,
                thought_tokens: 10,
                tool_calls: [{ name: 'read_file', args: { Path: '"/srv/work/projects/out.txt"' } }]
            },
            {
                step_index: 12,
                source: 'MODEL',
                type: 'READ_FILE',
                status: 'DONE',
                created_at: '2026-11-11T12:00:02Z',
                content: 'Created At: 2026-11-11T12:00:02Z\nCompleted At: 2026-11-11T12:00:02Z\n1: hello'
            },
            {
                step_index: 13,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-11T12:00:04Z',
                content: 'Background build succeeded.',
                input_tokens: 150,
                output_tokens: 20
            }
        ], bgCommands);

        expect(bgCommands).toEqual([]);
        expect(converted.durationMs).toBe(4_000);
        expect(converted.usage).toEqual({
            type: 'usage',
            inputTokens: 250,
            outputTokens: 50,
            thoughtTokens: 10,
            totalTokens: 310
        });
        expect(converted.messages).toEqual([
            {
                type: 'tool_result',
                id: 'call-bg-42',
                status: 'completed',
                output: {
                    output: 'Command exited with code 0.\n\nCommand output:\nBUILD_OK',
                    exit_code: 0
                }
            },
            { type: 'reasoning', text: 'Checking output file' },
            {
                type: 'tool_call',
                id: 'agy-wakeup-conv-xyz-11-0',
                name: 'read_file',
                input: { Path: '/srv/work/projects/out.txt' },
                status: 'completed',
                title: 'read_file',
                nativeName: 'read_file',
                nativeArgs: { Path: '/srv/work/projects/out.txt' }
            },
            {
                type: 'tool_result',
                id: 'agy-wakeup-conv-xyz-11-0',
                status: 'completed',
                output: '1: hello'
            },
            { type: 'text', text: 'Background build succeeded.' }
        ]);
    });

    it('does not register a replayed background command whose task a live turn already tracks', () => {
        // A live turn streamed step 37 and registered its command under the live
        // call id; the reactive slice then replays steps 36-39 from the transcript.
        const bgCommands: AgyOpenBackgroundCommand[] = [{ callId: 'call-live-37', taskId: 'conv-dup/task-38' }];
        const replay = convertAgyReactiveSteps('conv-dup', [
            {
                step_index: 36,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>\nTask id "conv-dup/task-31" finished with result:\nCommand exited with code 0.\n\nCommand output:\nEARLIER\n</SYSTEM_MESSAGE>'
            },
            {
                step_index: 37,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'run_command', args: { CommandLine: '"python3 scan.py"' } }]
            },
            {
                step_index: 38,
                source: 'MODEL',
                type: 'RUN_COMMAND',
                status: 'RUNNING',
                content: 'Created At: 2026-11-17T22:37:38-05:00\nTool is running as a background task with task id: conv-dup/task-38'
            },
            { step_index: 39, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Comparing the folders.' },
            {
                step_index: 40,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'run_command', args: { CommandLine: '"python3 move.py"' } }]
            },
            {
                step_index: 41,
                source: 'MODEL',
                type: 'RUN_COMMAND',
                status: 'RUNNING',
                content: 'Created At: 2026-11-17T22:39:06-05:00\nTool is running as a background task with task id: conv-dup/task-42'
            }
        ], bgCommands);

        // No second card or entry for task-38; a genuinely new background command still registers.
        expect(replay.messages.some((message) => 'id' in message && message.id === 'agy-wakeup-conv-dup-37-0')).toBe(false)
        expect(replay.messages.filter((message) => message.type === 'tool_call').map((message) => 'id' in message && message.id))
            .toEqual(['agy-wakeup-conv-dup-40-0'])
        expect(bgCommands.map((entry) => [entry.callId, entry.taskId])).toEqual([
            ['call-live-37', 'conv-dup/task-38'],
            ['agy-wakeup-conv-dup-40-0', 'conv-dup/task-42']
        ]);

        // task-38's single completion settles the live card, leaving only task-42 open.
        const completion = convertAgyReactiveSteps('conv-dup', [{
            step_index: 42,
            source: 'SYSTEM',
            type: 'SYSTEM_MESSAGE',
            status: 'DONE',
            content: '<SYSTEM_MESSAGE>\nTask id "conv-dup/task-38" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSCANNED\n</SYSTEM_MESSAGE>'
        }], bgCommands);
        expect(completion.messages).toEqual([{
            type: 'tool_result',
            id: 'call-live-37',
            status: 'completed',
            output: { output: 'Command exited with code 0.\n\nCommand output:\nSCANNED', exit_code: 0 }
        }]);
        expect(bgCommands.map((entry) => entry.callId)).toEqual(['agy-wakeup-conv-dup-40-0']);
    });

    it('matches background task completions in reverse order and ignores unmatched task IDs', () => {
        const bgCommands: AgyOpenBackgroundCommand[] = [
            { callId: 'call-first', taskId: 'conv-rev/task-1' },
            { callId: 'call-second', taskId: 'conv-rev/task-2' }
        ];

        // Unmatched task-99 does not consume call-first or call-second; task-2 completes first (exit 0), then task-1 fails (exit 2).
        const firstSlice = convertAgyReactiveSteps('conv-rev', [
            {
                step_index: 20,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>\nTask id "conv-rev/task-99" finished with result:\nCommand exited with code 0.\n\nCommand output:\nUNRELATED\n</SYSTEM_MESSAGE>'
            },
            {
                step_index: 21,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>\nTask id "conv-rev/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSECOND_OK\n</SYSTEM_MESSAGE>'
            }
        ], bgCommands);

        expect(firstSlice.messages).toEqual([
            {
                type: 'tool_result',
                id: 'call-second',
                status: 'completed',
                output: {
                    output: 'Command exited with code 0.\n\nCommand output:\nSECOND_OK',
                    exit_code: 0
                }
            }
        ]);
        expect(bgCommands).toEqual([{ callId: 'call-first', taskId: 'conv-rev/task-1' }]);

        const secondSlice = convertAgyReactiveSteps('conv-rev', [
            {
                step_index: 22,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>\nTask id "conv-rev/task-1" finished with result:\nCommand exited with code 2.\n\nCommand output:\nFIRST_FAILED\n</SYSTEM_MESSAGE>'
            }
        ], bgCommands);

        expect(secondSlice.messages).toEqual([
            {
                type: 'tool_result',
                id: 'call-first',
                status: 'failed',
                output: {
                    output: 'Command exited with code 2.\n\nCommand output:\nFIRST_FAILED',
                    exit_code: 2
                }
            }
        ]);
        expect(bgCommands).toEqual([]);
    });

    it('never FIFO-attributes completions to open background commands whose taskId is unknown', () => {
        const bgCommands: AgyOpenBackgroundCommand[] = [
            { callId: 'call-unknown-1' },
            { callId: 'call-unknown-2' }
        ];
        const slice = convertAgyReactiveSteps('conv-unknown', [
            {
                step_index: 10,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>\nTask id "conv-unknown/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSECOND_ONLY\n</SYSTEM_MESSAGE>'
            }
        ], bgCommands);

        expect(slice.messages).toEqual([]);
        expect(bgCommands).toEqual([
            { callId: 'call-unknown-1' },
            { callId: 'call-unknown-2' }
        ]);
    });

    it('preserves autonomous SYSTEM_MESSAGE steps at turn end while advancing past intra-turn folds', () => {
        // Post-terminal SYSTEM_MESSAGE arriving before prompt-answer callback is preserved.
        const postTerminalSteps: AgyTranscriptStep[] = [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
            { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn finished.' },
            { step_index: 2, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Wakeup</SYSTEM_MESSAGE>' }
        ];
        expect(advanceAgyTurnTranscriptCursor(
            postTerminalSteps,
            -1,
            new Map([['Turn finished.', 1]])
        )).toBe(1);

        // Intra-turn SYSTEM_MESSAGE folded into the active turn (before terminal planner, streamed text matches) advances.
        const intraTurnFolded: AgyTranscriptStep[] = [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ name: 'invoke_subagent', args: {} }]
            },
            { step_index: 2, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Fast subagent</SYSTEM_MESSAGE>' },
            { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Handled inside turn.' }
        ];
        expect(advanceAgyTurnTranscriptCursor(
            intraTurnFolded,
            -1,
            new Map([['Handled inside turn.', 1]])
        )).toBe(3);

        // Unstreamed text after SYSTEM_MESSAGE is preserved even if no earlier terminal planner was seen.
        expect(advanceAgyTurnTranscriptCursor(
            intraTurnFolded,
            -1,
            new Map()
        )).toBe(1);

        // Mixed batch with a confirmed backgrounded run_command + completed swarm_wait marks the
        // turn end so a subsequent tool-only autonomous wakeup ending in swarm_wait is preserved.
        const mixedBackgroundSwarmTurnFollowedByWakeup: AgyTranscriptStep[] = [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '/swarm start' },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                    { name: 'run_command', args: { CommandLine: '"sleep 10"' } },
                    { name: 'swarm_wait', args: { since: '1' } }
                ]
            },
            {
                step_index: 2,
                source: 'MODEL',
                type: 'RUN_COMMAND',
                status: 'RUNNING',
                content: 'Tool is running as a background task with task id: conv-1/task-1'
            },
            {
                step_index: 3,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'DONE',
                content: 'Waiting for a message that calls on you by name, or on @all posted after #1.'
            },
            {
                step_index: 4,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>Board message #2</SYSTEM_MESSAGE>'
            },
            {
                step_index: 5,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                    { name: 'post_message', args: { text: '"@worker ack"' } },
                    { name: 'swarm_wait', args: { since: '2' } }
                ]
            },
            {
                step_index: 6,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'DONE',
                content: '{"status":"posted","seq":3}'
            },
            {
                step_index: 7,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'DONE',
                content: 'Waiting for a message that calls on you by name, or on @all posted after #2.'
            }
        ];
        expect(advanceAgyTurnTranscriptCursor(
            mixedBackgroundSwarmTurnFollowedByWakeup,
            -1,
            new Map()
        )).toBe(3);
    });
});

describe('AgyAcpRemoteLauncher reactive wakeup integration', () => {
    let tempBrainDir: string;

    beforeEach(() => {
        tempBrainDir = mkdtempSync(join(tmpdir(), 'agy-launcher-wakeup-'));
    });

    afterEach(() => {
        rmSync(tempBrainDir, { recursive: true, force: true });
    });

    it.each(['silent', 'rename', 'late directory', 'silent replacement'])('recovers a transcript wakeup with a %s watcher', async (mode) => {
        vi.useFakeTimers();
        const { session } = makeHarness();
        const launcher = new AgyAcpRemoteLauncher(session, { brainDir: tempBrainDir, reactivePollMs: 350 });
        const id = 'agy-watcher';
        launcher['acpSessionId'] = id;
        launcher['backend'] = new WakeupTestBackend() as unknown as AcpSdkBackend;
        const controller = new AbortController();
        const existingTimers = vi.getTimerCount();
        const watchers: Array<ReturnType<typeof makeWatcher>> = [];
        function makeWatcher() {
            return Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
        }
        const mocked = vi.mocked(watch);
        const original = mocked.getMockImplementation()!;
        let available = mode !== 'late directory';
        mocked.mockImplementation(() => {
            if (!available) throw Error('ENOENT');
            const watcher = makeWatcher();
            watchers.push(watcher);
            return watcher as unknown as FSWatcher;
        });
        mocked.mockClear();
        try {
            writeTranscript(tempBrainDir, id, []);
            const waiting = launcher['waitForNextBatchOrWakeup'](controller.signal);
            let settled = false;
            void waiting.then(() => { settled = true; });
            if (!available) {
                available = true;
                await vi.advanceTimersByTimeAsync(350);
            }
            expect(watchers).toHaveLength(1);
            if (mode === 'rename') {
                const listener = mocked.mock.calls.at(-1)![1] as (event: string) => void;
                listener('rename');
            } else if (mode === 'silent replacement') {
                renameSync(join(tempBrainDir, id), join(tempBrainDir, id + '-old'));
                writeTranscript(tempBrainDir, id, []);
                await vi.advanceTimersByTimeAsync(30_000);
                expect(settled).toBe(false);
            }
            if (mode === 'rename' || mode === 'silent replacement') {
                expect(watchers[0].close).toHaveBeenCalledOnce();
                expect(watchers).toHaveLength(2);
            }
            writeTranscript(tempBrainDir, id, [{ step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE' }]);
            if (mode === 'rename' || mode === 'silent replacement') {
                const listener = mocked.mock.calls.at(-1)![1] as (event: string) => void;
                listener('change');
            } else {
                await vi.advanceTimersByTimeAsync(29_999);
                expect(settled).toBe(false);
                await vi.advanceTimersByTimeAsync(1);
            }
            await expect(waiting).resolves.toEqual({ kind: 'wakeup' });
            expect(vi.getTimerCount()).toBe(existingTimers);
        } finally {
            controller.abort();
            mocked.mockImplementation(original);
            vi.useRealTimers();
        }
    });

    it('rechecks a partial SYSTEM_MESSAGE after the final watcher event is dropped', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        try {
            const { session } = makeHarness();
            const id = 'agy-burst';
            const launcher = new AgyAcpRemoteLauncher(session, { brainDir: tempBrainDir, reactivePollMs: 350 });
            launcher['acpSessionId'] = id;
            launcher['backend'] = new WakeupTestBackend() as unknown as AcpSdkBackend;
            const { compactPath } = writeTranscript(tempBrainDir, id, []);
            const baseline = vi.getTimerCount();
            const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
            vi.mocked(watch).mockReturnValueOnce(watcher as unknown as FSWatcher);
            const waiting = launcher['waitForNextBatchOrWakeup'](controller.signal);
            const settled = vi.fn();
            void waiting.then(settled);
            const change = vi.mocked(watch).mock.calls.at(-1)![1] as (event: string) => void;
            appendFileSync(compactPath, '{"step_index":1,');
            change('change');
            await vi.advanceTimersByTimeAsync(200);
            appendFileSync(compactPath, '"source":"SYSTEM",');
            change('change');
            appendFileSync(compactPath, '"type":"SYSTEM_MESSAGE","status":"DONE"}\n');
            await vi.advanceTimersByTimeAsync(349);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toHaveBeenCalledWith({ kind: 'wakeup' });
            expect(vi.getTimerCount()).toBe(baseline);
        } finally {
            controller.abort();
            vi.useRealTimers();
        }
    });

    it('wakes up on completed background turn, emits background Bash result + text + summary, and advances cursor via resumeSession', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Turn 1 starts a background run_command and ends its turn while command is still in_progress.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-bg-1',
                name: 'sleep 5 && echo READY',
                title: 'sleep 5 && echo READY',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 5 && echo READY', toolSummary: 'Background check' }
            });
            onUpdate({ type: 'text', text: 'Waiting for background task...' });
            onUpdate({ type: 'usage', inputTokens: 40, outputTokens: 10 });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'run check' },
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 5 && echo READY"' } }]
                },
                {
                    step_index: 2,
                    source: 'MODEL',
                    type: 'RUN_COMMAND',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-1`
                },
                { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting for background task...' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('run check', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // The hub's background-task indicator mirrors the commands agy left
        // open at end_turn, keyed by their ACP call id.
        const claudeMessages = client.sendClaudeSessionMessage.mock.calls.map(([msg]) => msg);
        expect(claudeMessages).toContainEqual(expect.objectContaining({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [expect.objectContaining({
                task_id: 'call-bg-1',
                task_type: 'local_bash',
                description: 'sleep 5 && echo READY'
            })]
        }));

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        client.sendSessionEvent.mockClear();
        client.keepAlive.mockClear();

        // Simulate agy's autonomous background wakeup completing in transcript.jsonl with no open ACP turn.
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 4,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    created_at: '2026-11-11T12:10:00Z',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-1" finished with result:\nCommand exited with code 0.\n\nCommand output:\nREADY\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    created_at: '2026-11-11T12:10:01Z',
                    content: 'Background check finished: READY.',
                    input_tokens: 80,
                    output_tokens: 15
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.resumeCalls).toEqual([backend.sessionIdToCreate]);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // The wakeup's real completion retires the indicator entry: an empty
        // snapshot follows so the hub stops showing the command as running.
        expect(client.sendClaudeSessionMessage.mock.calls.map(([msg]) => msg)).toContainEqual(expect.objectContaining({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: []
        }));

        // Thinking transitioned true -> false during the reactive wakeup.
        const thinkingTransitions = client.keepAlive.mock.calls.map(([thinking]) => thinking);
        expect(thinkingTransitions[0]).toBe(true);
        expect(thinkingTransitions[thinkingTransitions.length - 1]).toBe(false);

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-bg-1',
            output: { stdout: 'READY', exit_code: 0 }
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Background check finished: READY.'
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'round-summary',
            summary: expect.objectContaining({
                provider: 'agy',
                num_turns: 1,
                agy_usage: expect.objectContaining({ input_tokens: 80, output_tokens: 15 })
            })
        }));
        // The prompt round counts its own model calls (the transcript's DONE
        // PLANNER_RESPONSE steps inside the turn), not the wakeup's.
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'round-summary',
            summary: expect.objectContaining({ provider: 'agy', num_turns: 2 })
        }));

        queue.close();
        await runPromise;
    });

    it('prefers an ACP-reported turn count over the transcript count in the prompt round summary', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'usage', inputTokens: 12, outputTokens: 4 });
            onUpdate({ type: 'text', text: 'Done.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn', numTurns: 9 });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'summarize' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done.' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('summarize', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'round-summary',
            summary: expect.objectContaining({ provider: 'agy', num_turns: 9 })
        }));

        queue.close();
        await runPromise;
    });

    it('reattaches with an internal ACP prompt when a reactive wakeup parks on a gated run_command', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Turn 1 launches subagents and ends turn.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Launched subagents, waiting...' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'audit homelab' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Launched subagents, waiting...' }
            ]);
        });

        // Internal wakeup continuation prompt unblocks SetPendingToolPermission -> auto-approves in always-proceed -> streams final answer!
        backend.promptScripts.push(async (onUpdate) => {
            backend.permissionHandler?.({
                id: 'perm-1',
                sessionId: backend.sessionIdToCreate,
                toolCallId: 'call-parked-1',
                title: 'tail -n 3 report.txt',
                options: [
                    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
                ]
            });
            await vi.waitFor(() => {
                expect(backend.permissionResponses).toHaveLength(1);
            });
            onUpdate({ type: 'text', text: 'Audit complete after subagent wakeup.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 40
        });
        const runPromise = launcher.launch();

        queue.push('audit homelab', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Subagent replies -> model calls gated `run_command` -> agy parks in SetPendingToolPermission!
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Subagent report ready</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"tail -n 3 report.txt"' } }]
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // Internal reattach prompt was sent without calling resumeSession first (so agy replays unstreamed steps).
        expect(backend.resumeCalls).toEqual([]);
        expect(backend.prompts[1]).toEqual([{ type: 'text', text: AGY_WAKEUP_CONTINUE_PROMPT }]);
        expect(backend.permissionResponses[0]).toEqual({ outcome: 'selected', optionId: 'allow_once' });

        // Internal prompt never leaks into abort-restore events.
        const events = client.sendSessionEvent.mock.calls.map(([e]) => e);
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'abort-restore' }));

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Audit complete after subagent wakeup.'
        }));

        queue.close();
        await runPromise;
    });

    it('yields immediately to a real user message queued while reactive wakeup is settling', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Turn 1 done.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'first' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done.' }
            ]);
        });
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'User follow-up handled.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 5_000,
            reactiveToolParkMs: 5_000
        });
        const runPromise = launcher.launch();

        queue.push('first', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.keepAlive.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            `${JSON.stringify({
                step_index: 2,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>Subagent returned</SYSTEM_MESSAGE>'
            })}\n`,
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.keepAlive).toHaveBeenCalledWith(true, 'remote', expect.anything());
        });

        queue.push('real user follow-up', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        expect(backend.prompts[1]).toEqual([{ type: 'text', text: 'real user follow-up' }]);
        expect(backend.resumeCalls).toEqual([]);

        queue.close();
        await runPromise;
    });

    it('cancels an in-progress reactive wakeup cleanly when the user presses Stop', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Started background agent...' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Started background agent...' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 5_000,
            reactiveToolParkMs: 5_000
        });
        const runPromise = launcher.launch();

        queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.keepAlive.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            `${JSON.stringify({
                step_index: 2,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: '<SYSTEM_MESSAGE>Wakeup started</SYSTEM_MESSAGE>'
            })}\n`,
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.keepAlive).toHaveBeenCalledWith(true, 'remote', expect.anything());
        });

        const abortHandler = client.rpcHandlerManager.handlers.get('abort');
        expect(abortHandler).toBeDefined();
        await abortHandler!();

        await vi.waitFor(() => {
            expect(backend.cancelCalls).toContain(backend.sessionIdToCreate);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Turn aborted' });
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        queue.close();
        await runPromise;
    });

    it('keeps tracking an unfinished wakeup across an inactivity timeout and surfaces late output when it arrives', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Dispatched slow subagent.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'run slow task' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Dispatched slow subagent.' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 500,
            reactiveMaxIdleMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('run slow task', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            `${JSON.stringify({
                step_index: 2,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                created_at: '2026-11-11T12:20:00Z',
                content: '<SYSTEM_MESSAGE>Subagent started replying slowly</SYSTEM_MESSAGE>'
            })}\n`,
            'utf8'
        );

        // First window hits reactiveMaxIdleMs (60ms): pauses to ready WITHOUT calling resumeSession.
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        expect(backend.resumeCalls).toEqual([]);
        client.sendSessionEvent.mockClear();

        // Late model completion arrives under the SAME SYSTEM_MESSAGE (no new SYSTEM_MESSAGE).
        appendFileSync(
            compactPath,
            `${JSON.stringify({
                step_index: 3,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-11T12:20:05Z',
                content: 'Late wakeup output after timeout.',
                input_tokens: 40,
                output_tokens: 12
            })}\n`,
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.resumeCalls).toEqual([backend.sessionIdToCreate]);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Late wakeup output after timeout.'
        }));

        queue.close();
        await runPromise;
    });

    it('reattaches when a wakeup completes an in-workspace read_file and then parks on a gated run_command in the same batch', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Waiting on subagent...' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting on subagent...' }
            ]);
        });
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Mixed batch continued cleanly.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 40,
            reactiveSlowToolParkMs: 5_000
        });
        const runPromise = launcher.launch();

        queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Subagent returned</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [
                        { name: 'read_file', args: { Path: '"/srv/work/projects/README.md"' } },
                        { name: 'run_command', args: { CommandLine: '"git status"' } }
                    ]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'READ_FILE',
                    status: 'DONE',
                    content: '1: # readme'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        expect(backend.prompts[1]).toEqual([{ type: 'text', text: AGY_WAKEUP_CONTINUE_PROMPT }]);
        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Mixed batch continued cleanly.'
        }));

        queue.close();
        await runPromise;
    });

    it('attributes reverse-order background command completions to the matching Bash card by task ID', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-bg-slow',
                name: 'sleep 10 && exit 2',
                title: 'sleep 10 && exit 2',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 10 && exit 2' }
            });
            onUpdate({
                type: 'tool_call',
                id: 'call-bg-fast',
                name: 'sleep 2 && echo FAST_OK',
                title: 'sleep 2 && echo FAST_OK',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 2 && echo FAST_OK' }
            });
            onUpdate({ type: 'text', text: 'Started two background commands.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'run two' },
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [
                        { name: 'run_command', args: { CommandLine: '"sleep 10 && exit 2"' } },
                        { name: 'run_command', args: { CommandLine: '"sleep 2 && echo FAST_OK"' } }
                    ]
                },
                {
                    step_index: 2,
                    source: 'MODEL',
                    type: 'RUN_COMMAND',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-1`
                },
                {
                    step_index: 3,
                    source: 'MODEL',
                    type: 'RUN_COMMAND',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-2`
                },
                {
                    step_index: 4,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Started two background commands.'
                }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('run two', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        // Second command (task-2) finishes FIRST; first command (task-1) finishes SECOND with exit code 2.
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 5,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nFAST_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-1" finished with result:\nCommand exited with code 2.\n\nCommand output:\nSLOW_FAIL\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 7,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Fast succeeded, slow failed.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-bg-fast',
            is_error: false,
            output: { stdout: 'FAST_OK', exit_code: 0 }
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-bg-slow',
            is_error: true,
            output: { stdout: 'SLOW_FAIL', exit_code: 2 }
        }));

        queue.close();
        await runPromise;
    });

    it('preserves a wakeup whose SYSTEM_MESSAGE lands in transcript.jsonl before onAnswered fires', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Simulate the race where agy closes its prompt turn and immediately writes an autonomous
        // SYSTEM_MESSAGE to transcript.jsonl BEFORE Node processes the session/prompt response (onAnswered).
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Dispatched fast subagent.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'go' },
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Dispatched fast subagent.'
                },
                {
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    created_at: '2026-11-11T12:30:00Z',
                    content: '<SYSTEM_MESSAGE>Subagent finished in race window</SYSTEM_MESSAGE>'
                }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 200
        });
        const runPromise = launcher.launch();

        queue.push('go', { permissionMode: 'always-proceed' }, 'msg-1');
        // Turn 1 finishes and immediately enters reactive wakeup tracking for step 2.
        await vi.waitFor(() => {
            expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'message',
                message: 'Dispatched fast subagent.'
            }));
        });
        client.sendSessionEvent.mockClear();

        // Autonomous MODEL step finishes after Turn 1's response settled (with no new SYSTEM_MESSAGE).
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            `${JSON.stringify({
                step_index: 3,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-11T12:30:01Z',
                content: 'Race-window subagent output surfaced.'
            })}\n`,
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.resumeCalls).toEqual([backend.sessionIdToCreate]);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Race-window subagent output surfaced.'
        }));

        queue.close();
        await runPromise;
    });

    it('resolves late-flushed RUN_COMMAND task IDs at wakeup time and attributes reverse-order completions', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // At Turn 1 close, RUN_COMMAND steps have not flushed to transcript.jsonl yet!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-late-slow',
                name: 'sleep 10 && exit 3',
                title: 'sleep 10 && exit 3',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 10 && exit 3' }
            });
            onUpdate({
                type: 'tool_call',
                id: 'call-late-fast',
                name: 'sleep 1 && echo LATE_FAST_OK',
                title: 'sleep 1 && echo LATE_FAST_OK',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 1 && echo LATE_FAST_OK' }
            });
            onUpdate({ type: 'text', text: 'Started two background tasks.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'run late' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('run late', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Turn 1's RUN_COMMAND steps flush to disk, followed by reverse-order completions (task-2 then task-1).
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [
                        { name: 'run_command', args: { CommandLine: '"sleep 10 && exit 3"' } },
                        { name: 'run_command', args: { CommandLine: '"sleep 1 && echo LATE_FAST_OK"' } }
                    ]
                }),
                JSON.stringify({
                    step_index: 2,
                    source: 'MODEL',
                    type: 'RUN_COMMAND',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-1`
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'RUN_COMMAND',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-2`
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Started two background tasks.'
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nLATE_FAST_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-1" finished with result:\nCommand exited with code 3.\n\nCommand output:\nLATE_SLOW_FAIL\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 7,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Both late-flushed tasks finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        expect(resolveAgyBackgroundTaskIds).toBeDefined();
        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-late-fast',
            is_error: false,
            output: { stdout: 'LATE_FAST_OK', exit_code: 0 }
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-late-slow',
            is_error: true,
            output: { stdout: 'LATE_SLOW_FAIL', exit_code: 3 }
        }));

        queue.close();
        await runPromise;
    });

    it('keeps call-ordinal task-ID alignment when an earlier background command completes mid-turn while a second remains open', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Command 1 starts in background (task-1) and completes mid-turn (e.g. during a steer),
        // while Command 2 starts in background (task-2) and remains open at end_turn.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-settled-in-steer',
                name: 'sleep 1 && echo STEER_DONE',
                title: 'sleep 1 && echo STEER_DONE',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 1 && echo STEER_DONE' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'call-settled-in-steer',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nSTEER_DONE', exit_code: 0 }
            });
            onUpdate({
                type: 'tool_call',
                id: 'call-still-open',
                name: 'sleep 10 && echo SECOND_BG_OK',
                title: 'sleep 10 && echo SECOND_BG_OK',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 10 && echo SECOND_BG_OK' }
            });
            onUpdate({ type: 'text', text: 'First finished in steer, second still running.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 1 && echo STEER_DONE"' } }]
                },
                {
                    step_index: 2,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'DONE',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-1`
                },
                { step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'steer' },
                {
                    step_index: 4,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 10 && echo SECOND_BG_OK"' } }]
                },
                {
                    step_index: 5,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-2`
                },
                {
                    step_index: 6,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'First finished in steer, second still running.'
                }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 7,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSECOND_BG_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 8,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Second background command completed.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-still-open',
            is_error: false,
            output: { stdout: 'SECOND_BG_OK', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('maps canonical stdout on a background run_command started in one reactive wakeup and completed in another', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Waiting on initial subagent...' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'go' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting on initial subagent...' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('go', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        // Wakeup 1: starts a background run_command (`task-5`) and finishes its wakeup turn.
        // The hub's background-task indicator must register the chained command even
        // though no ACP turn is open (it was started by the transcript-only wakeup).
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Subagent ready</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 3 && echo CHAINED_BG_OK"' } }]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-5`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Started chained background command.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // The chained command registers into the indicator with its command line,
        // mirroring what closeBackgroundCommands does for ACP-turn commands.
        const chainedCallId = `agy-wakeup-${backend.sessionIdToCreate}-3-0`;
        await vi.waitFor(() => {
            expect(client.sendClaudeSessionMessage.mock.calls.map(([msg]) => msg)).toContainEqual(
                expect.objectContaining({
                    type: 'system',
                    subtype: 'background_tasks_changed',
                    tasks: [expect.objectContaining({
                        task_id: chainedCallId,
                        task_type: 'local_bash',
                        description: 'sleep 3 && echo CHAINED_BG_OK'
                    })]
                })
            );
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Wakeup 2: `task-5` completes -> must emit canonical `{ stdout: 'CHAINED_BG_OK', exit_code: 0 }`!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-5" finished with result:\nCommand exited with code 0.\n\nCommand output:\nCHAINED_BG_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 7,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Chained command finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
            is_error: false,
            output: { stdout: 'CHAINED_BG_OK', exit_code: 0 }
        }));

        // The wakeup that settled the chained command also retires its indicator
        // entry: an empty snapshot follows so the hub stops showing it running.
        expect(client.sendClaudeSessionMessage.mock.calls.map(([msg]) => msg)).toContainEqual(
            expect.objectContaining({
                type: 'system',
                subtype: 'background_tasks_changed',
                tasks: []
            })
        );

        queue.close();
        await runPromise;
    });

    it('keeps one background entry when a live turn streams a wakeup run_command the watcher then replays', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');
        const acp = backend.sessionIdToCreate;

        // The turn ends, an earlier task's SYSTEM_MESSAGE wakes agy, and the same
        // live ACP stream carries the wakeup's backgrounded run_command and text.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-live-33',
                name: 'manage_task',
                title: 'manage_task',
                status: 'in_progress',
                input: {},
                nativeName: 'manage_task',
                nativeArgs: { Action: 'update' }
            });
            onUpdate({ type: 'tool_result', id: 'call-live-33', status: 'completed', output: 'Task list updated.' });
            onUpdate({ type: 'text', text: 'Task list updated.' });
            onUpdate({
                type: 'tool_call',
                id: 'call-live-37',
                name: 'python3 scan.py',
                title: 'python3 scan.py',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'python3 scan.py' }
            });
            onUpdate({ type: 'text', text: 'Comparing the folders.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, acp, [
                { step_index: 32, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'continue' },
                {
                    step_index: 33,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'manage_task', args: { Action: '"update"' } }]
                },
                { step_index: 34, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Task list updated.' },
                { step_index: 35, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Task list updated.' },
                {
                    step_index: 36,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${acp}/task-31" finished with result:\nCommand exited with code 0.\n\nCommand output:\nEARLIER\n</SYSTEM_MESSAGE>`
                },
                {
                    step_index: 37,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"python3 scan.py"' } }]
                },
                {
                    step_index: 38,
                    source: 'MODEL',
                    type: 'RUN_COMMAND',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${acp}/task-38`
                },
                { step_index: 39, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Comparing the folders.' }
            ]);
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        // The turn-end cursor stops at the terminal planner (35), so right after
        // the turn's ready the watcher replays 36-39 as a reactive wakeup.
        const readyCount = () => client.sendSessionEvent.mock.calls
            .filter(([event]) => event.type === 'ready').length;
        queue.push('continue', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(backend.resumeCalls).toEqual([acp]);
            expect(readyCount()).toBe(2);
        });
        client.sendSessionEvent.mockClear();

        // task-38's single completion arrives in a later wakeup.
        const { compactPath } = agyTranscriptPaths(tempBrainDir, acp)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 40,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${acp}/task-38" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSCANNED\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 41,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Scan finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.resumeCalls).toEqual([acp, acp]);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // The replayed step 37 never becomes a second card.
        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages.filter((msg) =>
            typeof msg.callId === 'string' && msg.callId.startsWith('agy-wakeup-')
        )).toEqual([]);
        // The completion lands on the live card.
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-live-37',
            is_error: false,
            output: { stdout: 'SCANNED', exit_code: 0 }
        }));

        // The indicator only ever tracked the live call id, and empties at the end.
        const snapshots = client.sendClaudeSessionMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg.type === 'system' && msg.subtype === 'background_tasks_changed');
        expect(snapshots.map((msg) => msg.tasks.map((task: { task_id: string }) => task.task_id))).toEqual([
            ['call-live-37'],
            []
        ]);

        queue.close();
        await runPromise;
    });

    it('associates task ID when a parked wakeup run_command is approved, backgrounds, and completes in a later wakeup', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Turn 1 starts a subagent and ends.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Waiting on subagent...' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting on subagent...' }
            ]);
        });

        // Internal wakeup reattach approves the parked `run_command`, which then backgrounds (`task-9`) before end_turn!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-replayed-bg',
                name: 'sleep 20 && echo REPLAYED_BG_DONE',
                title: 'sleep 20 && echo REPLAYED_BG_DONE',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 20 && echo REPLAYED_BG_DONE' }
            });
            onUpdate({ type: 'text', text: 'Approved command moved to background.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 4,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-9`
                    }),
                    JSON.stringify({
                        step_index: 5,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Approved command moved to background.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 40
        });
        const runPromise = launcher.launch();

        queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        // Subagent replies -> model calls gated `run_command` at step 3 and parks!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Subagent ready</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 20 && echo REPLAYED_BG_DONE"' } }]
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Later autonomous wakeup completes `task-9` -> must replace `call-replayed-bg` placeholder!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-9" finished with result:\nCommand exited with code 0.\n\nCommand output:\nREPLAYED_BG_DONE\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 7,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Replayed background command finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-replayed-bg',
            is_error: false,
            output: { stdout: 'REPLAYED_BG_DONE', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('counts pre-approval model calls in a reattached wakeup round summary', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Turn 1 ends; its transcript has steps 0-1.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Waiting on subagent...' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting on subagent...' }
            ]);
        });

        // Reattached internal turn: the gated command is approved and completes
        // in-turn, then the wakeup answers. Its transcript appends the final
        // planner response (step 4); the pre-approval planner call (step 3)
        // already sat in the transcript when this turn's cursor was synced.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-approved-1',
                name: 'echo hi',
                title: 'echo hi',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'echo hi' }
            });
            onUpdate({ type: 'tool_result', id: 'call-approved-1', output: { stdout: 'hi', exit_code: 0 }, status: 'completed' });
            onUpdate({ type: 'usage', inputTokens: 20, outputTokens: 6 });
            onUpdate({ type: 'text', text: 'Approved command finished.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 4,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Approved command finished.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 40
        });
        const runPromise = launcher.launch();

        queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        // Wakeup slice: SYSTEM_MESSAGE (step 2), then the planner call that
        // requests the gated command (step 3) parks on approval.
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Subagent ready</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo hi"' } }]
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // The reattached round counts the whole wakeup: the pre-approval
        // planner call (step 3) plus the final response (step 4) = 2 turns.
        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'round-summary',
            summary: expect.objectContaining({ provider: 'agy', num_turns: 2 })
        }));

        queue.close();
        await runPromise;
    });

    it('reconciles native ACP completion updates during a subsequent user prompt back to a reactive wakeup Bash card', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Initial turn done.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'first' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Initial turn done.' }
            ]);
        });

        // User sends a second prompt while `task-11` (started in Wakeup 1) finishes during that live ACP turn!
        backend.promptScripts.push(async (onUpdate) => {
            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                `${JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-11" finished with result:\nCommand exited with code 0.\n\nCommand output:\nLIVE_TURN_BG_OK\n</SYSTEM_MESSAGE>`
                })}\n`,
                'utf8'
            );
            onUpdate({
                type: 'tool_call',
                id: 'call_native_3',
                name: 'sleep 5 && echo LIVE_TURN_BG_OK',
                title: 'sleep 5 && echo LIVE_TURN_BG_OK',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 5 && echo LIVE_TURN_BG_OK' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'call_native_3',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nLIVE_TURN_BG_OK', exit_code: 0 }
            });
            onUpdate({ type: 'text', text: 'Handled follow-up with finished background result.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('first', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Wakeup 1 starts background `run_command` (`task-11`, synthetic ID `agy-wakeup-...-3-0`).
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Timer fired</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 5 && echo LIVE_TURN_BG_OK"' } }]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-11`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Started background check in wakeup.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // User sends next prompt; `call_native_3` reconciles onto `agy-wakeup-${sessionId}-3-0` without a duplicate tool-call card!
        queue.push('next user message', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call')).toEqual([]);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
            is_error: false,
            output: { stdout: 'LIVE_TURN_BG_OK', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('reconciles provisional in_progress ACP command calls when the synthetic task completion row flushes after tool_call starts', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Initial turn done.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'first' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Initial turn done.' }
            ]);
        });

        // `call_native_provisional` emits `in_progress` BEFORE `task-12`'s `SYSTEM_MESSAGE` completion row is written to disk!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call_native_provisional',
                name: 'sleep 5 && echo LATE_FLUSH_BG_OK',
                title: 'sleep 5 && echo LATE_FLUSH_BG_OK',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 5 && echo LATE_FLUSH_BG_OK' }
            });
            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                `${JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-12" finished with result:\nCommand exited with code 0.\n\nCommand output:\nLATE_FLUSH_BG_OK\n</SYSTEM_MESSAGE>`
                })}\n`,
                'utf8'
            );
            onUpdate({
                type: 'tool_call',
                id: 'call_native_provisional',
                name: 'sleep 5 && echo LATE_FLUSH_BG_OK',
                title: 'sleep 5 && echo LATE_FLUSH_BG_OK',
                status: 'completed',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 5 && echo LATE_FLUSH_BG_OK' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'call_native_provisional',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nLATE_FLUSH_BG_OK', exit_code: 0 }
            });
            onUpdate({ type: 'text', text: 'Handled late-flushed background result.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('first', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Timer fired</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 5 && echo LATE_FLUSH_BG_OK"' } }]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-12`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Started background check in wakeup.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        queue.push('next user message', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call')).toEqual([]);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
            is_error: false,
            output: { stdout: 'LATE_FLUSH_BG_OK', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('preserves replay task-ID attribution when a user prompt preempts a pending wakeup before reattachment', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Turn 1 ready.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 ready.' }
            ]);
        });

        // User preempts the parked wakeup: agy replays step 3's parked `run_command`,
        // which backgrounds (`task-21`), and finishes the user turn.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-preempted-bg',
                name: 'sleep 25',
                title: 'sleep 25',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 25' }
            });
            onUpdate({ type: 'text', text: 'Preempted command is running in background.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });

            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 4,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-21`
                    }),
                    JSON.stringify({
                        step_index: 5,
                        source: 'USER_EXPLICIT',
                        type: 'USER_INPUT',
                        content: 'user follow-up'
                    }),
                    JSON.stringify({
                        step_index: 6,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Preempted command is running in background.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 30,
            reactiveSettleMs: 30,
            reactiveToolParkMs: 500
        });
        const runPromise = launcher.launch();

        queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Write parked wakeup `PLANNER_RESPONSE` at step 3 AND immediately push a user prompt before `reactiveToolParkMs` (500ms) fires!
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        const oldIso = new Date(Date.now() - 50).toISOString();
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    created_at: oldIso,
                    content: '<SYSTEM_MESSAGE>Subagent note</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    created_at: oldIso,
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 25"' } }]
                })
            ].join('\n') + '\n',
            'utf8'
        );
        queue.push('user follow-up', { permissionMode: 'always-proceed' }, 'msg-2');

        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(backend.prompts[1]).toEqual([{ type: 'text', text: 'user follow-up' }]);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Later `task-21` completes autonomously in a reactive wakeup and must replace `call-preempted-bg`'s placeholder!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 7,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-21" finished with result:\nCommand exited with code 0.\n\nCommand output:\nPREEMPTED_BG_DONE\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 8,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Preempted background command finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-preempted-bg',
            is_error: false,
            output: { stdout: 'PREEMPTED_BG_DONE', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('excludes earlier-turn completed background tool_call updates with rawInput from current-turn command ordinals', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Turn 1 starts `call-bg-old` (`task-31`) in background.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-bg-old',
                name: 'sleep 10',
                title: 'sleep 10',
                status: 'in_progress',
                input: { CommandLine: 'sleep 10' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 10' }
            });
            onUpdate({ type: 'text', text: 'Old command backgrounded.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'turn 1' },
                {
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 10"' } }]
                },
                {
                    step_index: 2,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-31`
                },
                {
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Old command backgrounded.'
                }
            ]);
        });

        // Turn 2: `call-bg-old` completes WITH a completed `tool_call` (as AcpMessageHandler emits when rawInput is present),
        // followed by a brand-new `call-bg-new` (`task-32`) that backgrounds at ordinal 0 of Turn 2's transcript window!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-bg-old',
                name: 'sleep 10',
                title: 'sleep 10',
                status: 'completed',
                input: { CommandLine: 'sleep 10' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 10' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'call-bg-old',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nOLD_DONE', exit_code: 0 }
            });
            onUpdate({
                type: 'tool_call',
                id: 'call-bg-new',
                name: 'sleep 20',
                title: 'sleep 20',
                status: 'in_progress',
                input: { CommandLine: 'sleep 20' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 20' }
            });
            onUpdate({ type: 'text', text: 'New command backgrounded.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });

            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 4,
                        source: 'USER_EXPLICIT',
                        type: 'USER_INPUT',
                        content: 'turn 2'
                    }),
                    JSON.stringify({
                        step_index: 5,
                        source: 'SYSTEM',
                        type: 'SYSTEM_MESSAGE',
                        status: 'DONE',
                        content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-31" finished with result:\nCommand exited with code 0.\n\nCommand output:\nOLD_DONE\n</SYSTEM_MESSAGE>`
                    }),
                    JSON.stringify({
                        step_index: 6,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 20"' } }]
                    }),
                    JSON.stringify({
                        step_index: 7,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-32`
                    }),
                    JSON.stringify({
                        step_index: 8,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'New command backgrounded.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('turn 1', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        queue.push('turn 2', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Autonomous completion of `task-32` must resolve `call-bg-new` at ordinal 0 and replace its placeholder!
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 9,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-32" finished with result:\nCommand exited with code 0.\n\nCommand output:\nNEW_DONE\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 10,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'New background command finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-bg-new',
            is_error: false,
            output: { stdout: 'NEW_DONE', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('correlates reverse-order live completions of synthetic commands sharing CommandLine without swapping output or exit status', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Ready.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'init' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ready.' }
            ]);
        });

        // Live follow-up turn: both `task-41` (card 0, exit 0, SUITE_A_PASS) and `task-42` (card 1, exit 1, SUITE_B_FAIL)
        // share `CommandLine: 'npm test'`, both `SYSTEM_MESSAGE`s are persisted first, and ACP emits `task-42` BEFORE `task-41`!
        backend.promptScripts.push(async (onUpdate) => {
            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 7,
                        source: 'SYSTEM',
                        type: 'SYSTEM_MESSAGE',
                        status: 'DONE',
                        content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-41" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSUITE_A_PASS\n</SYSTEM_MESSAGE>`
                    }),
                    JSON.stringify({
                        step_index: 8,
                        source: 'SYSTEM',
                        type: 'SYSTEM_MESSAGE',
                        status: 'DONE',
                        content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-42" finished with result:\nCommand exited with code 1.\n\nCommand output:\nSUITE_B_FAIL\n</SYSTEM_MESSAGE>`
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            // Second synthetic command (`task-42`) completes FIRST over live ACP!
            onUpdate({
                type: 'tool_call',
                id: 'live_completion_second',
                name: 'npm test',
                title: 'npm test',
                status: 'failed',
                input: { CommandLine: 'npm test' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm test' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'live_completion_second',
                status: 'failed',
                output: { output: 'Command exited with code 1.\n\nCommand output:\nSUITE_B_FAIL', exit_code: 1 }
            });

            // First synthetic command (`task-41`) completes SECOND over live ACP!
            onUpdate({
                type: 'tool_call',
                id: 'live_completion_first',
                name: 'npm test',
                title: 'npm test',
                status: 'completed',
                input: { CommandLine: 'npm test' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm test' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'live_completion_first',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nSUITE_A_PASS', exit_code: 0 }
            });

            onUpdate({ type: 'text', text: 'Reported both npm test suites.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('init', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Reactive wakeup starts TWO background `npm test` commands (`agy-wakeup-...-3-0` -> `task-41`, `agy-wakeup-...-3-1` -> `task-42`).
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Run test suites</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [
                        { name: 'run_command', args: { CommandLine: '"npm test"' } },
                        { name: 'run_command', args: { CommandLine: '"npm test"' } }
                    ]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-41`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-42`
                }),
                JSON.stringify({
                    step_index: 6,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Both npm test suites started in background.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        queue.push('check test results', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call')).toEqual([]);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-1`,
            is_error: true,
            output: { stdout: 'SUITE_B_FAIL', exit_code: 1 }
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
            is_error: false,
            output: { stdout: 'SUITE_A_PASS', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('excludes late-flushed previous-turn planner rows from new-turn command ordinals while resolving previous task IDs', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        // Turn 1 backgrounds `call-turn1-late`, while only step 0 (`USER_INPUT`) has flushed by `ready`.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-turn1-late',
                name: 'sleep 30',
                title: 'sleep 30',
                status: 'in_progress',
                input: { CommandLine: 'sleep 30' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 30' }
            });
            onUpdate({ type: 'text', text: 'Turn 1 backgrounded.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'turn 1' }
            ]);
        });

        // Turn 2 starts a brand-new `call-turn2-new` (`task-52`) at ordinal 0 of Turn 2.
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-turn2-new',
                name: 'sleep 40',
                title: 'sleep 40',
                status: 'in_progress',
                input: { CommandLine: 'sleep 40' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 40' }
            });
            onUpdate({ type: 'text', text: 'Turn 2 backgrounded.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });

            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 4,
                        source: 'USER_EXPLICIT',
                        type: 'USER_INPUT',
                        content: 'turn 2'
                    }),
                    JSON.stringify({
                        step_index: 5,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 40"' } }]
                    }),
                    JSON.stringify({
                        step_index: 6,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-52`
                    }),
                    JSON.stringify({
                        step_index: 7,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Turn 2 backgrounded.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('turn 1', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Now Turn 1's planner/action rows (`task-51`) flush AFTER `ready`, with NO `SYSTEM_MESSAGE` yet!
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 1,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 30"' } }]
                }),
                JSON.stringify({
                    step_index: 2,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-51`
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Turn 1 backgrounded.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        // User sends Turn 2 before any autonomous wakeup occurs!
        queue.push('turn 2', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Both `task-52` (Turn 2) and `task-51` (Turn 1) finish in reverse order — each must update its own Bash card!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 8,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-52" finished with result:\nCommand exited with code 0.\n\nCommand output:\nTURN2_NEW_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 9,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-51" finished with result:\nCommand exited with code 0.\n\nCommand output:\nTURN1_LATE_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 10,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Both background commands finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-turn2-new',
            is_error: false,
            output: { stdout: 'TURN2_NEW_OK', exit_code: 0 }
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-turn1-late',
            is_error: false,
            output: { stdout: 'TURN1_LATE_OK', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('defers alias creation when only one of two matching synthetic tasks has persisted its completion and the other finishes first over ACP', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Ready.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'init' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ready.' }
            ]);
        });

        // Only `task-61` (card 0, exit 0, SUITE_A_PASS) has flushed its SYSTEM_MESSAGE!
        // `task-62` (card 1, exit 1, SUITE_B_FAIL) has NOT flushed its SYSTEM_MESSAGE yet when its live ACP completion arrives first!
        backend.promptScripts.push(async (onUpdate) => {
            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                `${JSON.stringify({
                    step_index: 7,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-61" finished with result:\nCommand exited with code 0.\n\nCommand output:\nSUITE_A_PASS\n</SYSTEM_MESSAGE>`
                })}\n`,
                'utf8'
            );

            // Unpersisted `task-62` finishes FIRST over ACP — must NOT alias onto `task-61`!
            onUpdate({
                type: 'tool_call',
                id: 'live_unpersisted_b',
                name: 'npm test',
                title: 'npm test',
                status: 'failed',
                input: { CommandLine: 'npm test' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm test' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'live_unpersisted_b',
                status: 'failed',
                output: { output: 'Command exited with code 1.\n\nCommand output:\nSUITE_B_FAIL', exit_code: 1 }
            });

            // Persisted `task-61` finishes SECOND over ACP!
            onUpdate({
                type: 'tool_call',
                id: 'live_persisted_a',
                name: 'npm test',
                title: 'npm test',
                status: 'completed',
                input: { CommandLine: 'npm test' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm test' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'live_persisted_a',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nSUITE_A_PASS', exit_code: 0 }
            });

            // `task-62`'s SYSTEM_MESSAGE flushes after both ACP updates; the retained `live_unpersisted_b`
            // completion now has corroborating completion evidence and reconciles onto `task-62`!
            appendFileSync(
                compactPath,
                `${JSON.stringify({
                    step_index: 8,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-62" finished with result:\nCommand exited with code 1.\n\nCommand output:\nSUITE_B_FAIL\n</SYSTEM_MESSAGE>`
                })}\n`,
                'utf8'
            );

            onUpdate({ type: 'text', text: 'Reported partial-persistence completions.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('init', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Run both test suites</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [
                        { name: 'run_command', args: { CommandLine: '"npm test"' } },
                        { name: 'run_command', args: { CommandLine: '"npm test"' } }
                    ]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-61`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-62`
                }),
                JSON.stringify({
                    step_index: 6,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Both npm test suites running.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        queue.push('check status', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const sentMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(sentMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call')).toEqual([]);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-1`,
            is_error: true,
            output: { stdout: 'SUITE_B_FAIL', exit_code: 1 }
        }));
        expect(sentMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
            is_error: false,
            output: { stdout: 'SUITE_A_PASS', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('does not alias a newly started identical command onto an unfinished synthetic command before the new planner row is persisted', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Ready.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'init' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ready.' }
            ]);
        });

        // Turn 2: synthetic `task-71` (`npm test`) is STILL RUNNING (no SYSTEM_MESSAGE),
        // and a brand-new `npm test` (`call-new-npm`) starts (`in_progress`) and finishes
        // BEFORE Turn 2's `PLANNER_RESPONSE` flushes to disk!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-new-npm',
                name: 'npm test',
                title: 'npm test',
                status: 'in_progress',
                input: { CommandLine: 'npm test' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm test' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'call-new-npm',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nFRESH_TURN_NPM_OK', exit_code: 0 }
            });
            onUpdate({ type: 'text', text: 'Ran fresh npm test.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });

            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 6,
                        source: 'USER_EXPLICIT',
                        type: 'USER_INPUT',
                        content: 'run npm test again'
                    }),
                    JSON.stringify({
                        step_index: 7,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }]
                    }),
                    JSON.stringify({
                        step_index: 8,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'DONE',
                        content: 'Command exited with code 0.\n\nCommand output:\nFRESH_TURN_NPM_OK'
                    }),
                    JSON.stringify({
                        step_index: 9,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Ran fresh npm test.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('init', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Wakeup 1 starts synthetic `npm test` (`task-71`), which stays running.
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Start long npm test</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-71`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Long npm test running in background.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Turn 2 runs a fresh `npm test` while `task-71` is still running: must emit `call-new-npm` card + result!
        queue.push('run npm test again', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const turn2Messages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(turn2Messages).toContainEqual(expect.objectContaining({
            type: 'tool-call',
            callId: 'call-new-npm',
            name: 'Bash'
        }));
        expect(turn2Messages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-new-npm',
            is_error: false,
            output: { stdout: 'FRESH_TURN_NPM_OK', exit_code: 0 }
        }));
        expect(turn2Messages).not.toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`
        }));

        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Later `task-71` finally finishes autonomously and updates its own synthetic card!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 10,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-71" finished with result:\nCommand exited with code 0.\n\nCommand output:\nLONG_BG_NPM_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 11,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Background npm test finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const wakeupMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(wakeupMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
            is_error: false,
            output: { stdout: 'LONG_BG_NPM_OK', exit_code: 0 }
        }));

        queue.close();
        await runPromise;
    });

    it('preserves call-ordinal task-ID attribution when a deferred fresh command is followed by a non-deferred command and both background', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Ready.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'init' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ready.' }
            ]);
        });

        // Turn 2: while synthetic `task-81` (`npm test`) is still running, the turn starts:
        //   Command A (`call-deferred-npm`, `npm test`, deferred because it matches `task-81`)
        //   Command B (`call-immediate-lint`, `npm run lint`, non-deferred)
        // BEFORE Turn 2's `PLANNER_RESPONSE` flushes to disk, and both stay `in_progress` at `end_turn`!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call-deferred-npm',
                name: 'npm test',
                title: 'npm test',
                status: 'in_progress',
                input: { CommandLine: 'npm test' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm test' }
            });
            onUpdate({
                type: 'tool_call',
                id: 'call-immediate-lint',
                name: 'npm run lint',
                title: 'npm run lint',
                status: 'in_progress',
                input: { CommandLine: 'npm run lint' },
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'npm run lint' }
            });
            onUpdate({ type: 'text', text: 'Started both background checks.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });

            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 6,
                        source: 'USER_EXPLICIT',
                        type: 'USER_INPUT',
                        content: 'run test and lint in background'
                    }),
                    JSON.stringify({
                        step_index: 7,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        tool_calls: [
                            { name: 'run_command', args: { CommandLine: '"npm test"' } },
                            { name: 'run_command', args: { CommandLine: '"npm run lint"' } }
                        ]
                    }),
                    JSON.stringify({
                        step_index: 8,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-82`
                    }),
                    JSON.stringify({
                        step_index: 9,
                        source: 'MODEL',
                        type: 'GENERIC',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-83`
                    }),
                    JSON.stringify({
                        step_index: 10,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Started both background checks.'
                    })
                ].join('\n') + '\n',
                'utf8'
            );
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('init', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Wakeup 1 starts synthetic `npm test` (`task-81`), which stays running.
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Start initial npm test</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-81`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Initial npm test running in background.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Turn 2 starts `call-deferred-npm` (`task-82`) and `call-immediate-lint` (`task-83`)
        queue.push('run test and lint in background', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Later `task-83` (lint) and `task-82` (npm test) complete in reverse order — each must update its own card!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 11,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-83" finished with result:\nCommand exited with code 1.\n\nCommand output:\nLINT_B_FAILED\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 12,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-82" finished with result:\nCommand exited with code 0.\n\nCommand output:\nDEFERRED_NPM_A_PASSED\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 13,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Both Turn 2 background commands finished.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        const wakeupMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(wakeupMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-deferred-npm',
            is_error: false,
            output: { stdout: 'DEFERRED_NPM_A_PASSED', exit_code: 0 }
        }));
        expect(wakeupMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-immediate-lint',
            is_error: true,
            output: { stdout: 'LINT_B_FAILED', exit_code: 1 }
        }));

        queue.close();
        await runPromise;
    });

    it('retains ambiguous live completions across turn end and reconciles onto the synthetic card when SYSTEM_MESSAGE persists after ready', async () => {
        const backend = new WakeupTestBackend();
        const { session, queue, client } = makeHarness('always-proceed');

        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({ type: 'text', text: 'Ready.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'init' },
                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ready.' }
            ]);
        });

        // Turn 2: `call_native_after_ready` completes over ACP and the turn finishes (`end_turn`)
        // BEFORE `task-91`'s `SYSTEM_MESSAGE` completion row is written to `transcript.jsonl`!
        backend.promptScripts.push(async (onUpdate) => {
            onUpdate({
                type: 'tool_call',
                id: 'call_native_after_ready',
                name: 'sleep 5 && echo AFTER_READY_BG_OK',
                title: 'sleep 5 && echo AFTER_READY_BG_OK',
                status: 'in_progress',
                input: {},
                nativeName: 'run_command',
                nativeArgs: { CommandLine: 'sleep 5 && echo AFTER_READY_BG_OK' }
            });
            onUpdate({
                type: 'tool_result',
                id: 'call_native_after_ready',
                status: 'completed',
                output: { output: 'Command exited with code 0.\n\nCommand output:\nAFTER_READY_BG_OK', exit_code: 0 }
            });
            onUpdate({ type: 'text', text: 'Handled background completion.' });
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        });

        const launcher = new AgyAcpRemoteLauncher(session, {
            createBackend: () => backend as unknown as AcpSdkBackend,
            brainDir: tempBrainDir,
            reactivePollMs: 15,
            reactiveSettleMs: 25,
            reactiveToolParkMs: 60
        });
        const runPromise = launcher.launch();

        queue.push('init', { permissionMode: 'always-proceed' }, 'msg-1');
        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();

        // Wakeup 1 starts synthetic `run_command` (`task-91`)
        const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 2,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: '<SYSTEM_MESSAGE>Timer fired</SYSTEM_MESSAGE>'
                }),
                JSON.stringify({
                    step_index: 3,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 5 && echo AFTER_READY_BG_OK"' } }]
                }),
                JSON.stringify({
                    step_index: 4,
                    source: 'MODEL',
                    type: 'GENERIC',
                    status: 'RUNNING',
                    content: `Tool is running as a background task with task id: ${backend.sessionIdToCreate}/task-91`
                }),
                JSON.stringify({
                    step_index: 5,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Started background check in wakeup.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });
        client.sendSessionEvent.mockClear();
        client.sendAgentMessage.mockClear();

        // Turn 2 finishes and returns to `ready` BEFORE `SYSTEM_MESSAGE` flushes to disk
        queue.push('next user message', { permissionMode: 'always-proceed' }, 'msg-2');
        await vi.waitFor(() => {
            expect(backend.prompts).toHaveLength(2);
            expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
        });

        // At `ready`, no duplicate `tool-call` or native `tool-call-result` has been emitted!
        const beforeFlushMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(beforeFlushMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call')).toEqual([]);
        expect(beforeFlushMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call-result')).toEqual([]);

        // Now `task-91`'s `SYSTEM_MESSAGE` and Turn 2's `PLANNER_RESPONSE` flush to disk AFTER `ready`!
        appendFileSync(
            compactPath,
            [
                JSON.stringify({
                    step_index: 6,
                    source: 'SYSTEM',
                    type: 'SYSTEM_MESSAGE',
                    status: 'DONE',
                    content: `<SYSTEM_MESSAGE>\nTask id "${backend.sessionIdToCreate}/task-91" finished with result:\nCommand exited with code 0.\n\nCommand output:\nAFTER_READY_BG_OK\n</SYSTEM_MESSAGE>`
                }),
                JSON.stringify({
                    step_index: 7,
                    source: 'MODEL',
                    type: 'PLANNER_RESPONSE',
                    status: 'DONE',
                    content: 'Handled background completion.'
                })
            ].join('\n') + '\n',
            'utf8'
        );

        await vi.waitFor(() => {
            const messages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
            expect(messages).toContainEqual(expect.objectContaining({
                type: 'tool-call-result',
                callId: `agy-wakeup-${backend.sessionIdToCreate}-3-0`,
                is_error: false,
                output: { stdout: 'AFTER_READY_BG_OK', exit_code: 0 }
            }));
        });

        const allMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg);
        expect(allMessages.filter((msg) => (msg as { type?: string }).type === 'tool-call')).toEqual([]);

        queue.close();
        await runPromise;
    });

    it('parses agy agentInfo.version for >= 1.5.10 live wakeup support', () => {
        expect(supportsAgyLiveIdleWakeups('1.5.10')).toBe(true);
        expect(supportsAgyLiveIdleWakeups('1.5.13')).toBe(true);
        expect(supportsAgyLiveIdleWakeups('1.6.0-beta.1')).toBe(true);
        expect(supportsAgyLiveIdleWakeups('2.0.0')).toBe(true);
        expect(supportsAgyLiveIdleWakeups('1.5.9')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('1.5.10-beta')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('1.5.10-rc.1')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('1.5.11-rc.1')).toBe(true);
        expect(supportsAgyLiveIdleWakeups('1.5.10+build.7')).toBe(true);
        expect(supportsAgyLiveIdleWakeups('1.5.10foo')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('v1.5.13')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('1.4.99')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('0.9.15')).toBe(false);
        expect(supportsAgyLiveIdleWakeups(null)).toBe(false);
        expect(supportsAgyLiveIdleWakeups(undefined)).toBe(false);
        expect(supportsAgyLiveIdleWakeups('')).toBe(false);
        expect(supportsAgyLiveIdleWakeups('unknown')).toBe(false);
    });

    it('renders idle agy >= 1.5.10 wakeup once via live ACP and flushes buffers before ready without leaking into Turn 2', async () => {
        const acpSessionId = 'conv-live-agy-1-5-13';
        const backend = new AcpSdkBackend({
            command: 'agy',
            args: ['acp'],
            flavor: 'agy',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null
        });
        const internal = backend as unknown as {
            transport: unknown;
            initializeResult: unknown;
            handleNotification: (method: string, params: unknown) => void;
        };
        const ctor = AcpSdkBackend as unknown as Record<string, number>;
        const savedTimings = {
            UPDATE_QUIET_PERIOD_MS: ctor.UPDATE_QUIET_PERIOD_MS,
            UPDATE_DRAIN_TIMEOUT_MS: ctor.UPDATE_DRAIN_TIMEOUT_MS,
            PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: ctor.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: ctor.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS,
            LATE_FLUSH_INTERVAL_MS: ctor.LATE_FLUSH_INTERVAL_MS,
            LATE_FLUSH_QUIET_PERIOD_MS: ctor.LATE_FLUSH_QUIET_PERIOD_MS,
            LATE_FLUSH_WINDOW_MS: ctor.LATE_FLUSH_WINDOW_MS
        };
        ctor.UPDATE_QUIET_PERIOD_MS = 10;
        ctor.UPDATE_DRAIN_TIMEOUT_MS = 40;
        ctor.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 10;
        ctor.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 40;
        ctor.LATE_FLUSH_INTERVAL_MS = 10;
        ctor.LATE_FLUSH_QUIET_PERIOD_MS = 20;
        ctor.LATE_FLUSH_WINDOW_MS = 60;

        try {
            let promptCount = 0;
            let alive = true;
            const resumeCalls: string[] = [];
            const notify = (update: Record<string, unknown>) => {
                internal.handleNotification('session/update', { sessionId: acpSessionId, update });
            };
            internal.transport = {
                sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
                    if (method === 'session/new') {
                        return { sessionId: acpSessionId, models: { availableModels: [], currentModelId: 'gemini-3.8-flash-low' } };
                    }
                    if (method === 'session/resume') {
                        resumeCalls.push(String(params.sessionId));
                        return { sessionId: String(params.sessionId), models: { availableModels: [], currentModelId: 'gemini-3.8-flash-low' } };
                    }
                    if (method === 'session/set_mode' || method === 'session/set_model') return {};
                    if (method === 'session/list') return { sessions: [] };
                    if (method === 'session/prompt') {
                        promptCount += 1;
                        if (promptCount === 1) {
                            notify({
                                sessionUpdate: 'tool_call',
                                toolCallId: 'call-bg-live-1',
                                name: 'run_command',
                                title: 'sleep 20 && echo DONE_BG',
                                status: 'in_progress',
                                rawInput: { CommandLine: 'sleep 20 && echo DONE_BG' }
                            });
                            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } });
                            writeTranscript(tempBrainDir, acpSessionId, [
                                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'run bg' },
                                {
                                    step_index: 1,
                                    source: 'MODEL',
                                    type: 'PLANNER_RESPONSE',
                                    status: 'DONE',
                                    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 20 && echo DONE_BG"' } }]
                                },
                                {
                                    step_index: 2,
                                    source: 'MODEL',
                                    type: 'RUN_COMMAND',
                                    status: 'RUNNING',
                                    content: `Tool is running as a background task with task id: ${acpSessionId}/task-1`
                                },
                                { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'STARTED' }
                            ]);
                        } else {
                            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
                            const { compactPath } = agyTranscriptPaths(tempBrainDir, acpSessionId)!;
                            appendFileSync(
                                compactPath,
                                [
                                    JSON.stringify({ step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Reply with only OK.' }),
                                    JSON.stringify({ step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' })
                                ].join('\n') + '\n',
                                'utf8'
                            );
                        }
                        return { stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 10 } };
                    }
                    return {};
                }),
                sendNotification: vi.fn(),
                onNotification: () => {},
                onStderrError: () => {},
                registerRequestHandler: () => {},
                isAlive: () => alive,
                getProcessPid: () => 4242,
                close: async () => { alive = false; return true; }
            };
            internal.initializeResult = {
                protocolVersion: 1,
                agentVersion: '1.5.13',
                agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
            };

            const { session, queue, client } = makeHarness('always-proceed');
            const launcher = new AgyAcpRemoteLauncher(session, {
                createBackend: () => backend,
                brainDir: tempBrainDir,
                reactivePollMs: 15,
                reactiveSettleMs: 25
            });
            const runPromise = launcher.launch();

            queue.push('run bg', { permissionMode: 'always-proceed' }, 'msg-1');
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
            client.sendSessionEvent.mockClear();
            client.sendAgentMessage.mockClear();
            const resumesBeforeWakeup = resumeCalls.length;

            // Idle wakeup streams tool_call_update + delta text chunks and writes transcript rows.
            notify({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-bg-live-1',
                status: 'completed',
                rawOutput: { output: 'Command exited with code 0.\n\nCommand output:\nDONE_BG', exit_code: 0 }
            });
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nFINISHED:' } });
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE_BG' } });
            const { compactPath } = agyTranscriptPaths(tempBrainDir, acpSessionId)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 4,
                        source: 'SYSTEM',
                        type: 'SYSTEM_MESSAGE',
                        status: 'DONE',
                        content: `<SYSTEM_MESSAGE>\nTask id "${acpSessionId}/task-1" finished with result:\nCommand exited with code 0.\n\nCommand output:\nDONE_BG\n</SYSTEM_MESSAGE>`
                    }),
                    JSON.stringify({
                        step_index: 5,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'FINISHED:DONE_BG',
                        input_tokens: 55,
                        output_tokens: 8
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));

            const wakeupMessages = client.sendAgentMessage.mock.calls.map(([msg]) => msg as {
                type?: string;
                message?: string;
                output?: { stdout?: string };
                summary?: { model?: string; num_turns?: number };
            });
            expect(wakeupMessages.filter((m) => m.type === 'message').map((m) => m.message?.trim())).toEqual(['FINISHED:DONE_BG']);
            expect(wakeupMessages.filter((m) => m.type === 'tool-call-result' && m.output?.stdout === 'DONE_BG')).toHaveLength(1);
            expect(wakeupMessages.find((m) => m.type === 'round-summary')?.summary).toMatchObject({
                model: 'gemini-3.8-flash-low',
                num_turns: 1
            });
            expect(resumeCalls).toHaveLength(resumesBeforeWakeup);

            // Wait past the 1000ms AcpMessageHandler idle timer and run Turn 2: zero leaked text.
            client.sendSessionEvent.mockClear();
            client.sendAgentMessage.mockClear();
            queue.push('Reply with only OK.', { permissionMode: 'always-proceed' }, 'msg-2');
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));

            const turn2Texts = client.sendAgentMessage.mock.calls
                .map(([msg]) => msg as { type?: string; message?: string })
                .filter((m) => m.type === 'message')
                .map((m) => m.message?.trim());
            expect(turn2Texts).toEqual(['OK']);

            queue.close();
            await runPromise;
        } finally {
            Object.assign(ctor, savedTimings);
        }
    });

    it('flushes live wakeups arriving during applyTurnConfig and waitForSessionUpdateQuiet before Turn 2 without duplicate rendering', async () => {
        const acpSessionId = 'conv-live-agy-preprompt-windows';
        const backend = new AcpSdkBackend({
            command: 'agy',
            args: ['acp'],
            flavor: 'agy',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null
        });
        const internal = backend as unknown as {
            transport: unknown;
            initializeResult: unknown;
            handleNotification: (method: string, params: unknown) => void;
        };
        const ctor = AcpSdkBackend as unknown as Record<string, number>;
        const savedTimings = {
            PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: ctor.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: ctor.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS,
            LATE_FLUSH_INTERVAL_MS: ctor.LATE_FLUSH_INTERVAL_MS,
            LATE_FLUSH_QUIET_PERIOD_MS: ctor.LATE_FLUSH_QUIET_PERIOD_MS,
            LATE_FLUSH_WINDOW_MS: ctor.LATE_FLUSH_WINDOW_MS
        };
        ctor.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 40;
        ctor.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 120;
        ctor.LATE_FLUSH_INTERVAL_MS = 10;
        ctor.LATE_FLUSH_QUIET_PERIOD_MS = 20;
        ctor.LATE_FLUSH_WINDOW_MS = 60;

        try {
            let promptCount = 0;
            let alive = true;
            const notify = (update: Record<string, unknown>) => {
                internal.handleNotification('session/update', { sessionId: acpSessionId, update });
            };
            const appendWakeup = (baseStep: number, text: string) => {
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
                const { compactPath } = agyTranscriptPaths(tempBrainDir, acpSessionId)!;
                appendFileSync(
                    compactPath,
                    [
                        JSON.stringify({
                            step_index: baseStep,
                            source: 'SYSTEM',
                            type: 'SYSTEM_MESSAGE',
                            status: 'DONE',
                            content: `<SYSTEM_MESSAGE>${text}</SYSTEM_MESSAGE>`
                        }),
                        JSON.stringify({
                            step_index: baseStep + 1,
                            source: 'MODEL',
                            type: 'PLANNER_RESPONSE',
                            status: 'DONE',
                            content: text,
                            input_tokens: 20,
                            output_tokens: 4
                        })
                    ].join('\n') + '\n',
                    'utf8'
                );
            };
            internal.transport = {
                sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
                    if (method === 'session/new') {
                        return { sessionId: acpSessionId, models: { availableModels: [], currentModelId: 'gemini-3.8-flash-low' } };
                    }
                    if (method === 'session/resume') return { sessionId: String(params.sessionId) };
                    if (method === 'session/set_mode') {
                        if (promptCount === 1) {
                            appendWakeup(2, 'FINISHED:DURING_CONFIG');
                        }
                        return {};
                    }
                    if (method === 'session/set_model') {
                        if (promptCount === 1) {
                            notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } });
                            setTimeout(() => appendWakeup(4, '\n\nFINISHED:QUIET_WINDOW'), 10);
                        }
                        return {};
                    }
                    if (method === 'session/list') return { sessions: [] };
                    if (method === 'session/prompt') {
                        promptCount += 1;
                        if (promptCount === 1) {
                            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } });
                            writeTranscript(tempBrainDir, acpSessionId, [
                                { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                                { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'STARTED' }
                            ]);
                        } else {
                            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
                            const { compactPath } = agyTranscriptPaths(tempBrainDir, acpSessionId)!;
                            appendFileSync(
                                compactPath,
                                [
                                    JSON.stringify({ step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Reply with only OK.' }),
                                    JSON.stringify({ step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' })
                                ].join('\n') + '\n',
                                'utf8'
                            );
                        }
                        return { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } };
                    }
                    return {};
                }),
                sendNotification: vi.fn(),
                onNotification: () => {},
                onStderrError: () => {},
                registerRequestHandler: () => {},
                isAlive: () => alive,
                getProcessPid: () => 4242,
                close: async () => { alive = false; return true; }
            };
            internal.initializeResult = {
                protocolVersion: 1,
                agentVersion: '1.5.13',
                agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
            };

            const { session, queue, client } = makeHarness('always-proceed');
            const launcher = new AgyAcpRemoteLauncher(session, {
                createBackend: () => backend,
                brainDir: tempBrainDir,
                reactivePollMs: 15,
                reactiveSettleMs: 25
            });
            const runPromise = launcher.launch();

            queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
            client.sendSessionEvent.mockClear();
            client.sendAgentMessage.mockClear();

            queue.push('Reply with only OK.', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));

            // Wait a few poll ticks to verify the post-turn watcher does not re-render either wakeup.
            await new Promise((r) => setTimeout(r, 60));

            const texts = client.sendAgentMessage.mock.calls
                .map(([msg]) => msg as { type?: string; message?: string })
                .filter((m) => m.type === 'message')
                .map((m) => m.message?.trim());
            expect(texts).toEqual(['FINISHED:DURING_CONFIG\n\nFINISHED:QUIET_WINDOW', 'OK']);

            queue.close();
            await runPromise;
        } finally {
            Object.assign(ctor, savedTimings);
        }
    });

    it('closes and registers a background run_command started inside a live agy >= 1.5.10 wakeup under its live ACP callId', async () => {
        const acpSessionId = 'conv-live-agy-wakeup-bg-cmd';
        const backend = new AcpSdkBackend({
            command: 'agy',
            args: ['acp'],
            flavor: 'agy',
            textChunkMode: 'delta',
            toolCallLifetimeStore: null
        });
        const internal = backend as unknown as {
            transport: unknown;
            initializeResult: unknown;
            handleNotification: (method: string, params: unknown) => void;
        };
        const ctor = AcpSdkBackend as unknown as Record<string, number>;
        const savedTimings = {
            LATE_FLUSH_INTERVAL_MS: ctor.LATE_FLUSH_INTERVAL_MS,
            LATE_FLUSH_QUIET_PERIOD_MS: ctor.LATE_FLUSH_QUIET_PERIOD_MS,
            LATE_FLUSH_WINDOW_MS: ctor.LATE_FLUSH_WINDOW_MS
        };
        ctor.LATE_FLUSH_INTERVAL_MS = 10;
        ctor.LATE_FLUSH_QUIET_PERIOD_MS = 20;
        ctor.LATE_FLUSH_WINDOW_MS = 60;

        try {
            let alive = true;
            const notify = (update: Record<string, unknown>) => {
                internal.handleNotification('session/update', { sessionId: acpSessionId, update });
            };
            internal.transport = {
                sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
                    if (method === 'session/new') {
                        return { sessionId: acpSessionId, models: { availableModels: [], currentModelId: 'gemini-3.8-flash-low' } };
                    }
                    if (method === 'session/resume') return { sessionId: String(params.sessionId) };
                    if (method === 'session/set_mode' || method === 'session/set_model') return {};
                    if (method === 'session/list') return { sessions: [] };
                    if (method === 'session/prompt') {
                        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn 1 ready.' } });
                        writeTranscript(tempBrainDir, acpSessionId, [
                            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                            { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 ready.' }
                        ]);
                        return { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } };
                    }
                    return {};
                }),
                sendNotification: vi.fn(),
                onNotification: () => {},
                onStderrError: () => {},
                registerRequestHandler: () => {},
                isAlive: () => alive,
                getProcessPid: () => 4242,
                close: async () => { alive = false; return true; }
            };
            internal.initializeResult = {
                protocolVersion: 1,
                agentVersion: '1.5.13',
                agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
            };

            const { session, queue, client } = makeHarness('always-proceed');
            const launcher = new AgyAcpRemoteLauncher(session, {
                createBackend: () => backend,
                brainDir: tempBrainDir,
                reactivePollMs: 15,
                reactiveSettleMs: 25
            });
            const runPromise = launcher.launch();

            queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
            client.sendSessionEvent.mockClear();
            client.sendAgentMessage.mockClear();
            client.sendClaudeSessionMessage.mockClear();

            // Live wakeup starts a new background run_command and finishes its wakeup turn.
            notify({
                sessionUpdate: 'tool_call',
                toolCallId: 'call-wakeup-bg-1',
                name: 'run_command',
                title: 'sleep 20 && echo WAKEUP_BG',
                status: 'in_progress',
                rawInput: { CommandLine: 'sleep 20 && echo WAKEUP_BG' }
            });
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wakeup started bg.' } });
            const { compactPath } = agyTranscriptPaths(tempBrainDir, acpSessionId)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 2,
                        source: 'SYSTEM',
                        type: 'SYSTEM_MESSAGE',
                        status: 'DONE',
                        content: '<SYSTEM_MESSAGE>timer fired</SYSTEM_MESSAGE>'
                    }),
                    JSON.stringify({
                        step_index: 3,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 20 && echo WAKEUP_BG"' } }]
                    }),
                    JSON.stringify({
                        step_index: 4,
                        source: 'MODEL',
                        type: 'RUN_COMMAND',
                        status: 'RUNNING',
                        content: `Tool is running as a background task with task id: ${acpSessionId}/task-7`
                    }),
                    JSON.stringify({
                        step_index: 5,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: 'Wakeup started bg.',
                        input_tokens: 30,
                        output_tokens: 6
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));

            const messages = client.sendAgentMessage.mock.calls.map(([msg]) => msg as {
                type?: string;
                callId?: string;
                message?: string;
                output?: { stdout?: string };
            });
            expect(messages.filter((m) => m.type === 'message').map((m) => m.message?.trim())).toEqual(['Wakeup started bg.']);
            expect(messages.filter((m) => m.type === 'tool-call')).toHaveLength(1);
            expect(messages).toContainEqual(expect.objectContaining({
                type: 'tool-call-result',
                callId: expect.stringMatching(/^call-wakeup-bg-1#/),
                output: expect.objectContaining({
                    stdout: 'Running in the background. The result appears when agy reports it.'
                })
            }));

            const bgEntries = (launcher as unknown as {
                backgroundCommands: Array<{ callId: string; taskId?: string; synthetic?: boolean }>;
            }).backgroundCommands;
            expect(bgEntries).toEqual([
                expect.objectContaining({
                    callId: expect.stringMatching(/^call-wakeup-bg-1#/)
                })
            ]);
            expect(client.sendClaudeSessionMessage.mock.calls.map(([msg]) => msg)).toContainEqual(
                expect.objectContaining({
                    type: 'system',
                    subtype: 'background_tasks_changed',
                    tasks: [
                        expect.objectContaining({
                            task_id: expect.stringMatching(/^call-wakeup-bg-1#/),
                            description: 'sleep 20 && echo WAKEUP_BG'
                        })
                    ]
                })
            );

            queue.close();
            await runPromise;
        } finally {
            Object.assign(ctor, savedTimings);
        }
    });

    it('gates live idle wakeup mode on agentInfo.version >= 1.5.10 and preserves legacy transcript rendering for < 1.5.10 or unknown versions', async () => {
        for (const version of ['1.5.9', null]) {
            const backend = new WakeupTestBackend();
            backend.sessionIdToCreate = `conv-legacy-${version ?? 'null'}`;
            backend.agentVersion = version;
            backend.promptScripts.push(async (onUpdate) => {
                onUpdate({ type: 'text', text: 'Turn 1 done.' });
                writeTranscript(tempBrainDir, backend.sessionIdToCreate, [
                    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1 done.' }
                ]);
                onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
            });

            const { session, queue, client } = makeHarness('always-proceed');
            const launcher = new AgyAcpRemoteLauncher(session, {
                createBackend: () => backend as unknown as AcpSdkBackend,
                brainDir: tempBrainDir,
                reactivePollMs: 15,
                reactiveSettleMs: 25
            });
            const runPromise = launcher.launch();

            queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
            client.sendSessionEvent.mockClear();
            client.sendAgentMessage.mockClear();

            const { compactPath } = agyTranscriptPaths(tempBrainDir, backend.sessionIdToCreate)!;
            appendFileSync(
                compactPath,
                [
                    JSON.stringify({
                        step_index: 2,
                        source: 'SYSTEM',
                        type: 'SYSTEM_MESSAGE',
                        status: 'DONE',
                        content: '<SYSTEM_MESSAGE>legacy done</SYSTEM_MESSAGE>'
                    }),
                    JSON.stringify({
                        step_index: 3,
                        source: 'MODEL',
                        type: 'PLANNER_RESPONSE',
                        status: 'DONE',
                        content: `LEGACY_REPLY_${version ?? 'null'}`
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            await vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));

            const texts = client.sendAgentMessage.mock.calls
                .map(([msg]) => msg as { type?: string; message?: string })
                .filter((m) => m.type === 'message')
                .map((m) => m.message?.trim());
            expect(texts).toEqual([`LEGACY_REPLY_${version ?? 'null'}`]);
            expect(backend.resumeCalls).toEqual([backend.sessionIdToCreate]);

            queue.close();
            await runPromise;
        }
    });

    describe('live agy >= 1.5.10 wakeup lifecycle edges', () => {
        const wakeup = (base: number, content: string, extra: Array<Record<string, unknown>> = [], done = true) => [
            { step_index: base, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>${content}</SYSTEM_MESSAGE>` },
            ...extra,
            ...(done ? [{ step_index: base + extra.length + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content }] : [])
        ];
        const bgRows = (base: number, command: string, taskId: string, done = true) => wakeup(base, 'bg', [
            { step_index: base + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify(command) } }] },
            { step_index: base + 2, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${taskId}` }
        ].slice(0, 2), done).map((row, i) => i > 0 && done ? { ...row, step_index: base + i } : row);

        function startLive(
            acpSessionId: string,
            onPrompt: (n: number, notify: (update: Record<string, unknown>) => void) => string | void | Promise<string | void>,
            launcherOpts: Record<string, number> = {},
            resumeSessionId: string | null = null,
            onMethod: (method: string) => void | Promise<void> = () => {}
        ) {
            const backend = new AcpSdkBackend({ command: 'agy', args: ['acp'], flavor: 'agy', textChunkMode: 'delta', toolCallLifetimeStore: null });
            const internal = backend as unknown as { transport: unknown; initializeResult: unknown; handleNotification: (m: string, p: unknown) => void };
            const ctor = AcpSdkBackend as unknown as Record<string, number>;
            const saved = { ...ctor };
            Object.assign(ctor, {
                PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: 10, PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: 40,
                UPDATE_QUIET_PERIOD_MS: 10, UPDATE_DRAIN_TIMEOUT_MS: 40,
                LATE_FLUSH_INTERVAL_MS: 10, LATE_FLUSH_QUIET_PERIOD_MS: 20, LATE_FLUSH_WINDOW_MS: 60
            });
            const notify = (update: Record<string, unknown>) => internal.handleNotification('session/update', { sessionId: acpSessionId, update });
            const requests: string[] = [];
            let prompts = 0;
            internal.transport = {
                sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
                    requests.push(method);
                    await onMethod(method);
                    if (method === 'session/new') return { sessionId: acpSessionId, models: { availableModels: [], currentModelId: 'gemini-3.8-flash-low' } };
                    if (method === 'session/resume') return { sessionId: String(params.sessionId) };
                    if (method === 'session/list') return { sessions: [] };
                    if (method === 'session/prompt') {
                        prompts += 1;
                        return { stopReason: (await onPrompt(prompts, notify)) ?? 'end_turn' };
                    }
                    return {};
                }),
                sendNotification: vi.fn(), onNotification: () => {}, onStderrError: () => {}, registerRequestHandler: () => {},
                isAlive: () => true, getProcessPid: () => 4242, close: async () => true
            };
            internal.initializeResult = { protocolVersion: 1, agentVersion: '1.5.13', agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };
            const { session, queue, client } = makeHarness('always-proceed', resumeSessionId);
            const launcher = new AgyAcpRemoteLauncher(session, { createBackend: () => backend, brainDir: tempBrainDir, reactivePollMs: 15, reactiveSettleMs: 25, ...launcherOpts });
            const run = launcher.launch();
            const append = (rows: Array<Record<string, unknown>>) => appendFileSync(
                agyTranscriptPaths(tempBrainDir, acpSessionId)!.compactPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
            const texts = () => client.sendAgentMessage.mock.calls
                .map(([m]) => m as { type?: string; message?: string }).filter((m) => m.type === 'message').map((m) => m.message?.trim());
            const ready = () => vi.waitFor(() => expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
            const bgEntries = () => (launcher as unknown as { backgroundCommands: Array<{ callId: string; taskId?: string; synthetic?: boolean }> }).backgroundCommands;
            const finish = async () => { queue.close(); await run; Object.assign(ctor, saved); };
            return { notify, append, texts, ready, bgEntries, finish, queue, client, requests };
        }
        const turnRows = (acp: string) => writeTranscript(tempBrainDir, acp, [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
            { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Turn 1.' }
        ]);
        const bgCall = (id: string, cmd: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, name: 'run_command', title: cmd, status: 'in_progress', rawInput: { CommandLine: cmd } });

        it('renders a wakeup from the transcript while no prompt has installed a message handler yet (resumed session)', async () => {
            const acp = 'conv-live-resumed';
            turnRows(acp);
            const h = startLive(acp, () => undefined, {}, acp);
            await vi.waitFor(() => expect(h.requests).toContain('session/resume'));
            h.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FINISHED:RESUMED' } });
            h.append(wakeup(2, 'FINISHED:RESUMED'));
            await h.ready();
            expect(h.texts()).toEqual(['FINISHED:RESUMED']);
            await h.finish();
        });

        it('registers a background command started in a live wakeup after a cancelled turn', async () => {
            const acp = 'conv-live-cancelled';
            const h = startLive(acp, (_n, notify) => {
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
                turnRows(acp);
                return 'cancelled';
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.notify(bgCall('call-w-1', 'sleep 9'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`));
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(1));
            expect(h.bgEntries()).toEqual([{ callId: expect.stringMatching(/^call-w-1#/) }]);
            await h.finish();
        });

        it('closes a live wakeup command when a queued prompt preempts the wakeup', async () => {
            const acp = 'conv-live-preempt';
            const h = startLive(acp, (n, notify) => {
                if (n === 1) { turnRows(acp); return; }
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
                h.append([
                    { step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'next' },
                    { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' }
                ]);
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify(bgCall('call-w-2', 'sleep 9'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`, false));
            h.queue.push('next', { permissionMode: 'always-proceed' }, 'msg-2');
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(1));
            expect(h.bgEntries()[0]).toMatchObject({ callId: expect.stringMatching(/^call-w-2#/) });
            await h.finish();
        });

        it('keeps a preempted wakeup command out of the next turn task id binding', async () => {
            const acp = 'conv-live-preempt-both';
            const h = startLive(acp, (n, notify) => {
                if (n === 1) { turnRows(acp); return; }
                notify(bgCall('call-t2', 'sleep 8'));
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
                h.append([
                    { step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'next' },
                    { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 8"' } }] },
                    { step_index: 7, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${acp}/task-8` },
                    { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' }
                ]);
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify(bgCall('call-w-4', 'sleep 9'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`, false));
            h.queue.push('next', { permissionMode: 'always-proceed' }, 'msg-2');
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(2));
            const byCall = (prefix: string) => h.bgEntries().find((e) => e.callId.startsWith(prefix));
            expect(byCall('call-w-4#')?.taskId).toBeUndefined();
            expect(byCall('call-t2#')?.taskId).toBe(`${acp}/task-8`);
            await h.finish();
        });

        it('does not turn a command into a background task when the user stops its live wakeup', async () => {
            const acp = 'conv-live-stop-cmd';
            const h = startLive(acp, () => { turnRows(acp); });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            h.notify(bgCall('call-stopped', 'sleep 9'));
            h.append(wakeup(2, 'w', [], false));
            await new Promise((r) => setTimeout(r, 60));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            await h.ready();
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-stopped#'))).toHaveLength(0);
            expect(h.bgEntries()).toHaveLength(0);
            await h.finish();
        });

        it('does not close a cancelled prompt command as a background task in a later text-only wakeup', async () => {
            const acp = 'conv-live-cancel-text';
            const h = startLive(acp, (_n, notify) => {
                notify(bgCall('call-cancelled', 'sleep 30'));
                turnRows(acp);
                return 'cancelled';
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            h.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'just text' } });
            h.append(wakeup(2, 'just text'));
            await h.ready();
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call-result')).toHaveLength(0);
            expect(h.bgEntries().filter((e) => !e.synthetic)).toHaveLength(0);
            await h.finish();
        });

        it('never gives a preempted wakeup command a task id from late rows of the previous prompt', async () => {
            const acp = 'conv-live-late-rows';
            const h = startLive(acp, (n, notify) => {
                if (n === 1) { turnRows(acp); return; }
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
                h.append([
                    { step_index: 9, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'next' },
                    { step_index: 10, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' }
                ]);
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.append([
                { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 5"' } }] },
                { step_index: 3, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${acp}/task-5` },
                ...bgRows(4, 'sleep 9', `${acp}/task-7`, false)
            ]);
            h.notify(bgCall('call-w-5', 'sleep 9'));
            h.queue.push('next', { permissionMode: 'always-proceed' }, 'msg-2');
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(1));
            expect(h.bgEntries()).toEqual([expect.objectContaining({ callId: expect.stringMatching(/^call-w-5#/) })]);
            expect(h.bgEntries()[0]!.taskId).toBeUndefined();
            await h.finish();
        });

        it('settles a wakeup command that starts during the pre-prompt quiet wait and keeps the next turn command apart', async () => {
            const acp = 'conv-live-quiet-swap';
            const h = startLive(acp, (n, notify) => {
                if (n === 1) { turnRows(acp); return; }
                notify(bgCall('call-b', 'sleep 8'));
                h.append([
                    { step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'next' },
                    { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 8"' } }] },
                    { step_index: 7, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${acp}/task-8` },
                    { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' }
                ]);
            }, {}, null, (method) => {
                if (method !== 'session/set_model') return;
                // A fresh frame opens the quiet wait; the command lands inside it, after the old settle point.
                h.notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } });
                setTimeout(() => {
                    h.notify(bgCall('call-a', 'sleep 9'));
                    h.append(bgRows(2, 'sleep 9', `${acp}/task-7`, false));
                }, 3);
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(2));
            const byCall = (prefix: string) => h.bgEntries().find((e) => e.callId.startsWith(prefix));
            expect(byCall('call-a#')?.taskId).toBeUndefined();
            expect(byCall('call-b#')?.taskId).toBe(`${acp}/task-8`);
            await h.finish();
        });

        it('does not promote a wakeup command to a background task when Stop lands in the pre-prompt quiet wait', async () => {
            const acp = 'conv-live-quiet-stop';
            const h = startLive(acp, () => { turnRows(acp); }, {}, null, (method) => {
                if (method !== 'session/set_model') return;
                h.notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } });
                setTimeout(() => {
                    h.notify(bgCall('call-q', 'sleep 9'));
                    h.append(bgRows(2, 'sleep 9', `${acp}/task-7`, false));
                }, 3);
                setTimeout(() => { void h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!(); }, 6);
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await h.ready();
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-q#'))).toHaveLength(0);
            expect(h.bgEntries().filter((e) => e.callId.startsWith('call-q#'))).toHaveLength(0);
            await h.finish();
        });

        it('never gives a prompt command the task id of a wakeup whose rows flush after the handler swap', async () => {
            const acp = 'conv-live-rows-after';
            const h = startLive(acp, (n, notify) => {
                if (n === 1) { turnRows(acp); return; }
                notify(bgCall('call-b3', 'sleep 8'));
                h.append([
                    ...bgRows(2, 'sleep 9', `${acp}/task-7`, false),
                    { step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'next' },
                    { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 8"' } }] },
                    { step_index: 7, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${acp}/task-8` },
                    { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' }
                ]);
            }, {}, null, (method) => {
                if (method !== 'session/set_model') return;
                h.notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } });
                setTimeout(() => h.notify(bgCall('call-a3', 'sleep 9')), 3);
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(2));
            const byCall = (prefix: string) => h.bgEntries().find((e) => e.callId.startsWith(prefix));
            expect(byCall('call-a3#')?.taskId).toBeUndefined();
            expect(byCall('call-b3#')?.taskId).toBe(`${acp}/task-8`);
            await h.finish();
        });

        it('keeps a parked wakeup command and the command approved after reattach apart', async () => {
            const acp = 'conv-live-parked';
            const h = startLive(acp, (n, notify) => {
                if (n === 1) { turnRows(acp); return; }
                notify(bgCall('call-b4', 'sleep 8'));
                h.append([
                    { step_index: 6, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${acp}/task-8` },
                    { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'done' }
                ]);
            }, { reactiveToolParkMs: 40 });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify(bgCall('call-a4', 'sleep 9'));
            h.append([
                ...bgRows(2, 'sleep 9', `${acp}/task-7`, false),
                { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 8"' } }] }
            ]);
            await vi.waitFor(() => expect(h.requests.filter((r) => r === 'session/prompt')).toHaveLength(2));
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(2));
            const byCall = (prefix: string) => h.bgEntries().find((e) => e.callId.startsWith(prefix));
            expect(byCall('call-a4#')?.taskId).toBeUndefined();
            expect(byCall('call-b4#')?.taskId).toBeUndefined();
            await h.finish();
        });

        it('settles a registered wakeup command from its live completion by call id', async () => {
            const acp = 'conv-live-complete';
            const h = startLive(acp, () => { turnRows(acp); });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.notify(bgCall('call-c5', 'sleep 9'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`));
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(1));
            h.client.sendAgentMessage.mockClear();
            h.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-c5', status: 'completed', rawOutput: { output: 'Command output:\nDONE', exit_code: 0 } });
            await vi.waitFor(() => expect(h.bgEntries()).toHaveLength(0));
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-c5#'))).toHaveLength(1);
            await h.finish();
        });

        it('forwards the result of a transcript-rendered command that completes after a prompt installed the handler (resumed session)', async () => {
            const acp = 'conv-live-synthetic';
            turnRows(acp);
            const h = startLive(acp, (_n, notify) => {
                notify(bgCall('call-x', 'echo hi'));
                notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-x', status: 'completed', rawOutput: { output: 'Command output:\nhi', exit_code: 0 } });
                h.append([
                    { step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                    { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo hi"' } }] },
                    { step_index: 8, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', content: 'hi' }
                ]);
            }, {}, acp);
            await vi.waitFor(() => expect(h.requests).toContain('session/resume'));
            // Handler-less wakeup: rendered from the transcript as a synthetic card.
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`));
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.synthetic)).toBe(true));
            h.client.sendSessionEvent.mockClear();
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            // The synthetic command completes: result-only ACP update first, transcript row later.
            h.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-syn', status: 'completed', rawOutput: { output: 'Command exited with code 0.\n\nCommand output:\nDONE', exit_code: 0 } });
            await new Promise((r) => setTimeout(r, 40));
            h.append([
                { step_index: 9, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\nTask id "${acp}/task-7" finished with result:\nCommand exited with code 0.\n\nCommand output:\nDONE\n</SYSTEM_MESSAGE>` },
                { step_index: 10, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'FINISHED:DONE' }
            ]);
            await h.ready();
            const out = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string; output?: { stdout?: string } });
            const results = out.filter((m) => m.type === 'tool-call-result');
            expect(results.some((m) => m.callId?.startsWith('agy-wakeup-') && m.output?.stdout === 'DONE')).toBe(true);
            await h.finish();
        });

        it('does not register a stopped wakeup command when Stop lands while the next prompt configuration is pending', async () => {
            const acp = 'conv-live-config-stop';
            let release = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const h = startLive(acp, () => { turnRows(acp); }, {}, null, (method) => (method === 'session/set_model' ? gate : undefined));
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.notify(bgCall('call-cfg', 'sleep 9'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`, false));
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await vi.waitFor(() => expect(h.requests).toContain('session/set_model'));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            // A late start of the stopped wakeup still reaches the old handler.
            h.notify(bgCall('call-cfg-late', 'sleep 8'));
            release();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            await h.ready();
            h.queue.push('again', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-3');
            await vi.waitFor(() => expect(h.requests.filter((r) => r === 'session/prompt')).toHaveLength(2));
            await h.ready();
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-cfg'))).toHaveLength(0);
            expect(h.bgEntries().filter((e) => e.callId.startsWith('call-cfg'))).toHaveLength(0);
            // The discard ended with the stopped activity: a later wakeup registers normally.
            h.notify(bgCall('call-after-cfg', 'sleep 7'));
            h.append(bgRows(10, 'sleep 7', `${acp}/task-9`));
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.callId.startsWith('call-after-cfg#'))).toBe(true));
            await h.finish();
        });

        it('registers a later wakeup command normally after the user stopped a prompt turn', async () => {
            const acp = 'conv-live-stop-turn';
            let release = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const h = startLive(acp, async (n) => {
                if (n === 1) { turnRows(acp); return; }
                await gate;
                return 'cancelled';
            });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed' }, 'msg-2');
            await vi.waitFor(() => expect(h.requests.filter((r) => r === 'session/prompt')).toHaveLength(2));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            release();
            await h.ready();
            h.notify(bgCall('call-after-turn', 'sleep 7'));
            h.append(bgRows(2, 'sleep 7', `${acp}/task-9`));
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.callId.startsWith('call-after-turn#'))).toBe(true));
            await h.finish();
        });

        it('registers a later wakeup command normally after Stop during prompt configuration', async () => {
            const acp = 'conv-live-stop-config-later';
            let release = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const h = startLive(acp, () => { turnRows(acp); }, {}, null, (method) => (method === 'session/set_model' ? gate : undefined));
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await vi.waitFor(() => expect(h.requests).toContain('session/set_model'));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            release();
            await h.ready();
            h.notify(bgCall('call-after-cfg2', 'sleep 7'));
            h.append(bgRows(2, 'sleep 7', `${acp}/task-9`));
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.callId.startsWith('call-after-cfg2#'))).toBe(true));
            await h.finish();
        });

        it('completes a transcript-rendered command from its transcript row when no live update arrives', async () => {
            const acp = 'conv-live-synthetic-row';
            turnRows(acp);
            const h = startLive(acp, (_n, notify) => {
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
                h.append([
                    { step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                    { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok' }
                ]);
            }, {}, acp);
            await vi.waitFor(() => expect(h.requests).toContain('session/resume'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`));
            await h.ready();
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.synthetic)).toBe(true));
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            await new Promise((r) => setTimeout(r, 40));
            h.append([
                { step_index: 8, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\nTask id "${acp}/task-7" finished with result:\nCommand exited with code 0.\n\nCommand output:\nDONE\n</SYSTEM_MESSAGE>` },
                { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'FINISHED:DONE' }
            ]);
            const sent = () => h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string; output?: { stdout?: string } });
            await vi.waitFor(() => expect(sent().filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('agy-wakeup-') && m.output?.stdout === 'DONE')).toHaveLength(1));
            await h.ready();
            const out = sent();
            expect(out.filter((m) => m.type === 'tool-call')).toHaveLength(0);
            expect(h.bgEntries()).toHaveLength(0);
            // The live result of the same command arrives after the card ended: no second card.
            h.client.sendAgentMessage.mockClear();
            const done = { output: 'Command exited with code 0.\n\nCommand output:\nDONE', exit_code: 0 };
            // A different command with identical output completes first: it keeps its own card.
            h.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'other-call', status: 'completed', rawOutput: done });
            // The duplicate names the task it belongs to: no second card.
            h.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'task-7', status: 'completed', rawOutput: done });
            await new Promise((r) => setTimeout(r, 1200)); // past the idle flush of the message handler
            const late = sent().filter((m) => m.type === 'tool-call-result');
            expect(late.filter((m) => m.callId?.startsWith('other-call#'))).toHaveLength(1);
            expect(late.filter((m) => m.callId?.startsWith('task-7#'))).toHaveLength(0);
            await h.finish();
        });

        it('emits and registers a wakeup command whose start was deferred behind a transcript-rendered command', async () => {
            const acp = 'conv-live-deferred';
            turnRows(acp);
            const h = startLive(acp, (_n, notify) => {
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
                h.append([
                    { step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                    { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok' }
                ]);
            }, {}, acp);
            await vi.waitFor(() => expect(h.requests).toContain('session/resume'));
            // Handler-less wakeup: command A is rendered from the transcript and keeps running.
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`));
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.synthetic)).toBe(true));
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            // A later live wakeup starts a same-args command; its ACP start precedes its planner row.
            h.notify(bgCall('call-b7', 'sleep 9'));
            await new Promise((r) => setTimeout(r, 40));
            h.append([
                { step_index: 8, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>timer</SYSTEM_MESSAGE>' },
                { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 9"' } }] },
                { step_index: 10, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: `Tool is running as a background task with task id: ${acp}/task-9` },
                { step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'started' }
            ]);
            const sent = () => h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            await vi.waitFor(() => expect(sent().filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-b7#'))).toHaveLength(1));
            await h.ready();
            const out = sent();
            expect(out.filter((m) => m.type === 'tool-call' && m.callId?.startsWith('call-b7#'))).toHaveLength(1);
            expect(out.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-b7#'))).toHaveLength(1);
            expect(h.bgEntries().some((e) => e.callId.startsWith('call-b7#'))).toBe(true);
            await h.finish();
        });

        it('drops a late start of a stopped wakeup command after ready', async () => {
            const acp = 'conv-live-stop-late-id';
            let release = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const h = startLive(acp, () => { turnRows(acp); }, {}, null, (method) => (method === 'session/set_model' ? gate : undefined));
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify(bgCall('call-stopped-id', 'sleep 9'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`, false));
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await vi.waitFor(() => expect(h.requests).toContain('session/set_model'));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            release();
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            // The unacknowledged cancel lets one more start of the stopped command through.
            h.notify(bgCall('call-stopped-id', 'sleep 9'));
            await new Promise((r) => setTimeout(r, 40));
            h.queue.push('again', { permissionMode: 'always-proceed' }, 'msg-3');
            await vi.waitFor(() => expect(h.requests.filter((r) => r === 'session/prompt')).toHaveLength(2));
            await h.ready();
            expect(h.bgEntries().filter((e) => e.callId.startsWith('call-stopped-id#'))).toHaveLength(0);
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('call-stopped-id#'))).toHaveLength(0);
            await h.finish();
        });

        it('lets a first-seen command start after ready through as a normal wakeup command (accepted limit)', async () => {
            const acp = 'conv-live-first-seen';
            let release = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const h = startLive(acp, () => { turnRows(acp); }, {}, null, (method) => (method === 'session/set_model' ? gate : undefined));
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await vi.waitFor(() => expect(h.requests).toContain('session/set_model'));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            release();
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            // After ready nothing tells a first-seen start of the stopped wakeup from a new wakeup's:
            // it is tracked like any wakeup command (it can show as running; the next prompt registers it).
            h.notify(bgCall('call-first-seen', 'sleep 9'));
            await new Promise((r) => setTimeout(r, 40));
            h.queue.push('again', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-3');
            await vi.waitFor(() => expect(h.requests.filter((r) => r === 'session/prompt')).toHaveLength(2));
            await h.ready();
            expect(h.bgEntries().some((e) => e.callId.startsWith('call-first-seen#'))).toBe(true);
            await h.finish();
        });

        it('registers a later wakeup command whose start precedes its row after a Stop', async () => {
            const acp = 'conv-live-later-wakeup';
            let release = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const h = startLive(acp, () => { turnRows(acp); }, {}, null, (method) => (method === 'session/set_model' ? gate : undefined));
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('next', { permissionMode: 'always-proceed', model: 'gemini-3.8-flash-high' }, 'msg-2');
            await vi.waitFor(() => expect(h.requests).toContain('session/set_model'));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            release();
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            // A later autonomous wakeup: its first-seen start precedes its SYSTEM_MESSAGE row, then the row flushes.
            h.notify(bgCall('call-new-wakeup', 'sleep 9'));
            await new Promise((r) => setTimeout(r, 40));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-9`));
            await h.ready();
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string });
            expect(results.filter((m) => m.type === 'tool-call' && m.callId?.startsWith('call-new-wakeup#'))).toHaveLength(1);
            expect(h.bgEntries().some((e) => e.callId.startsWith('call-new-wakeup#'))).toBe(true);
            await h.finish();
        });

        it('does not retain a late result of a settled task against another open transcript command', async () => {
            const acp = 'conv-live-settled-first';
            turnRows(acp);
            const done = (out: string) => ({ output: `Command exited with code 0.\n\nCommand output:\n${out}`, exit_code: 0 });
            const finished = (task: string, out: string) => `<SYSTEM_MESSAGE>\nTask id "${acp}/${task}" finished with result:\nCommand exited with code 0.\n\nCommand output:\n${out}\n</SYSTEM_MESSAGE>`;
            const h = startLive(acp, (_n, notify) => {
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
                h.append([
                    { step_index: 10, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start' },
                    { step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok' }
                ]);
            }, {}, acp);
            await vi.waitFor(() => expect(h.requests).toContain('session/resume'));
            h.append(bgRows(2, 'sleep 9', `${acp}/task-7`));
            await vi.waitFor(() => expect(h.bgEntries().filter((e) => e.synthetic)).toHaveLength(1));
            await h.ready();
            h.append(bgRows(6, 'sleep 8', `${acp}/task-8`));
            await vi.waitFor(() => expect(h.bgEntries().filter((e) => e.synthetic)).toHaveLength(2));
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendAgentMessage.mockClear();
            h.client.sendSessionEvent.mockClear();
            await new Promise((r) => setTimeout(r, 40));
            // Task 7 ends from its transcript row; its late result names it while task 8 is still open.
            h.append([
                { step_index: 12, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: finished('task-7', 'DONE') },
                { step_index: 13, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'one done' }
            ]);
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'task-7', status: 'completed', rawOutput: done('DONE') });
            await new Promise((r) => setTimeout(r, 40));
            h.append([
                { step_index: 14, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: finished('task-8', 'OTHER') },
                { step_index: 15, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'two done' }
            ]);
            await h.ready();
            const results = h.client.sendAgentMessage.mock.calls.map(([m]) => m as { type?: string; callId?: string; output?: { stdout?: string } });
            expect(results.filter((m) => m.type === 'tool-call-result' && m.callId?.startsWith('task-7#'))).toHaveLength(0);
            expect(results.filter((m) => m.type === 'tool-call-result' && m.output?.stdout === 'OTHER')).toHaveLength(1);
            await h.finish();
        });

        it('seals buffered wakeup text when the wakeup times out', async () => {
            const acp = 'conv-live-timeout';
            const h = startLive(acp, () => { turnRows(acp); }, { reactiveMaxIdleMs: 60 });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL' } });
            h.append(wakeup(2, 'PARTIAL', [], false));
            await h.ready();
            expect(h.texts()).toContain('PARTIAL');
            await h.finish();
        });

        it('seals wakeup text when the user stops a live wakeup and still registers the next wakeup command', async () => {
            const acp = 'conv-live-stop';
            const h = startLive(acp, () => { turnRows(acp); });
            h.queue.push('start', { permissionMode: 'always-proceed' }, 'msg-1');
            await h.ready();
            h.client.sendSessionEvent.mockClear();
            h.notify(bgCall('fg-1', 'ls'));
            h.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'W1PARTIAL' } });
            h.append(wakeup(2, 'w1', [], false));
            await new Promise((r) => setTimeout(r, 60));
            await h.client.rpcHandlerManager.handlers.get(RPC_METHODS.Abort)!();
            await h.ready();
            expect(h.texts()).toContain('W1PARTIAL');
            h.notify(bgCall('call-w-3', 'sleep 9'));
            h.append(bgRows(10, 'sleep 9', `${acp}/task-9`));
            await vi.waitFor(() => expect(h.bgEntries().some((e) => e.callId.startsWith('call-w-3#'))).toBe(true));
            expect(h.bgEntries().find((e) => e.callId.startsWith('call-w-3#'))?.taskId).toBeUndefined();
            await h.finish();
        });
    });
});
