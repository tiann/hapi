import { describe, expect, it } from 'vitest';
import { formatPerfReport, type PerfSnapshot } from './doctorPerf';

describe('formatPerfReport', () => {
    it('summarizes busy sessions, token pressure, and warnings', () => {
        const snapshot: PerfSnapshot = {
            generatedAt: '2026-05-02T15:30:00.000Z',
            runner: {
                running: true,
                pid: 33246,
                sessions: 2
            },
            sessions: [
                {
                    id: 'session-busy',
                    title: 'Busy Thread',
                    active: true,
                    thinking: true,
                    pendingRequestsCount: 0,
                    updatedAt: 1777735800000,
                    seq: 42,
                    codexSessionId: 'thread-busy',
                    runnerPid: 123,
                    backendKind: 'codex',
                    backendProcessPids: [124, 125],
                    appServerPids: [124, 125],
                    token: {
                        lastTotalTokens: 220000,
                        modelContextWindow: 258400,
                        pressurePercent: 85.1
                    },
                    recent: {
                        readySeq: 40,
                        contextCompactedSeq: null,
                        failedSeq: null
                    },
                    warnings: ['token pressure 85.1%']
                },
                {
                    id: 'session-idle',
                    title: 'Idle Thread',
                    active: true,
                    thinking: false,
                    pendingRequestsCount: 0,
                    updatedAt: 1777735700000,
                    seq: 8,
                    codexSessionId: 'thread-idle',
                    runnerPid: 223,
                    backendKind: 'codex',
                    backendProcessPids: [224],
                    appServerPids: [224],
                    token: null,
                    recent: {
                        readySeq: 8,
                        contextCompactedSeq: null,
                        failedSeq: null
                    },
                    warnings: []
                }
            ],
            untrackedAppServerPids: [999],
            externalAppServerPids: [888],
            warnings: ['1 untracked HAPI Codex app-server process']
        };

        const report = formatPerfReport(snapshot);

        expect(report).toContain('Runner: running pid=33246 sessions=2');
        expect(report).toContain('Busy: 1/2');
        expect(report).toContain('Busy Thread');
        expect(report).toContain('backend=codex:124,125');
        expect(report).toContain('tokens last=220000/258400 (85.1%)');
        expect(report).toContain('warnings: token pressure 85.1%');
        expect(report).toContain('Untracked HAPI app-server PIDs: 999');
        expect(report).toContain('External Codex app-server PIDs: 888');
    });
});
