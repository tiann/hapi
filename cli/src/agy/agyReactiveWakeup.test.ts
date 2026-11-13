import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage, PermissionRequest, PromptContent } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
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
    type AgyOpenBackgroundCommand,
    type AgyReactiveTimingConfig,
    type AgyTranscriptStep
} from './agyReactiveWakeup';

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

function makeHarness(permissionMode: AgyMode['permissionMode'] = 'always-proceed') {
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
        sessionId: null,
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
});
