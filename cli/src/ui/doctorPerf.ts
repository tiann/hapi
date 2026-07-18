import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import psList from 'ps-list';
import { configuration } from '@/configuration';
import { readRunnerState, readSettings } from '@/persistence';
import { listRunnerSessions } from '@/runner/controlClient';

export type PerfTokenSnapshot = {
    lastTotalTokens: number | null;
    lastInputTokens?: number | null;
    cachedInputTokens?: number | null;
    totalTokens?: number | null;
    modelContextWindow: number | null;
    pressurePercent: number | null;
};

export type PerfRecentEvents = {
    readySeq: number | null;
    contextCompactedSeq: number | null;
    failedSeq: number | null;
};

export type PerfBackendKind = 'codex' | 'claude' | 'agy' | 'grok' | 'unknown';

export type PerfSessionSnapshot = {
    id: string;
    title: string;
    active: boolean;
    thinking: boolean;
    pendingRequestsCount: number;
    updatedAt: number | null;
    seq: number | null;
    codexSessionId: string | null;
    runnerPid: number | null;
    backendKind: PerfBackendKind;
    backendProcessPids: number[];
    appServerPids: number[];
    model?: string | null;
    modelReasoningEffort?: string | null;
    token: PerfTokenSnapshot | null;
    recent: PerfRecentEvents;
    warnings: string[];
};

export type PerfSnapshot = {
    generatedAt: string;
    runner: {
        running: boolean;
        pid: number | null;
        sessions: number;
    };
    sessions: PerfSessionSnapshot[];
    untrackedAppServerPids: number[];
    externalAppServerPids: number[];
    warnings: string[];
};

type ApiSession = {
    id?: string;
    title?: string;
    active?: boolean;
    thinking?: boolean;
    pendingRequestsCount?: number;
    updatedAt?: number;
    seq?: number;
    model?: string | null;
    modelReasoningEffort?: string | null;
    metadata?: {
        title?: string;
        codexSessionId?: string;
        flavor?: string;
        pid?: number;
    };
};

type ProcessInfo = {
    pid: number;
    ppid?: number;
    cmd?: string;
    name?: string;
};

export type DoctorPerfOptions = {
    json?: boolean;
    limit?: number;
};

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
    if (!value.trim()) {
        return [];
    }
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

function quoteSql(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function readSqliteJson(dbPath: string, sql: string): Array<Record<string, unknown>> {
    if (!existsSync(dbPath)) {
        return [];
    }

    try {
        const output = execFileSync('sqlite3', [
            '-readonly',
            '-json',
            dbPath,
            sql
        ], {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 2_000
        });
        return parseJsonArray(output);
    } catch {
        return [];
    }
}

function hapiDbPath(): string {
    return join(configuration.happyHomeDir, 'hapi.db');
}

async function fetchApiSessions(): Promise<ApiSession[]> {
    const settings = await readSettings();
    const accessToken = settings.cliApiToken;
    if (!accessToken) {
        return [];
    }

    const baseUrl = configuration.apiUrl.replace(/\/$/, '');
    const authResponse = await fetch(`${baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken }),
        signal: AbortSignal.timeout(3_000)
    });

    if (!authResponse.ok) {
        return [];
    }

    const authJson = await authResponse.json() as { token?: string };
    if (!authJson.token) {
        return [];
    }

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`, {
        headers: { authorization: `Bearer ${authJson.token}` },
        signal: AbortSignal.timeout(3_000)
    });

    if (!sessionsResponse.ok) {
        return [];
    }

    const sessionsJson = await sessionsResponse.json() as { sessions?: ApiSession[] };
    return Array.isArray(sessionsJson.sessions) ? sessionsJson.sessions : [];
}

function readTokenSnapshot(sessionId: string): PerfTokenSnapshot | null {
    const rows = readSqliteJson(hapiDbPath(), `
        SELECT
            json_extract(content, '$.content.data.info.last.totalTokens') AS lastTotalTokens,
            json_extract(content, '$.content.data.info.last.inputTokens') AS lastInputTokens,
            json_extract(content, '$.content.data.info.last.cachedInputTokens') AS cachedInputTokens,
            json_extract(content, '$.content.data.info.total.totalTokens') AS totalTokens,
            json_extract(content, '$.content.data.info.modelContextWindow') AS modelContextWindow
        FROM messages
        WHERE session_id = ${quoteSql(sessionId)}
          AND json_extract(content, '$.content.data.type') = 'token_count'
        ORDER BY seq DESC
        LIMIT 1;
    `);
    const row = rows[0];
    if (!row) {
        return null;
    }

    const lastTotalTokens = asNumber(row.lastTotalTokens);
    const modelContextWindow = asNumber(row.modelContextWindow);
    const pressurePercent = lastTotalTokens !== null && modelContextWindow
        ? Math.round((lastTotalTokens / modelContextWindow) * 1000) / 10
        : null;

    return {
        lastTotalTokens,
        lastInputTokens: asNumber(row.lastInputTokens),
        cachedInputTokens: asNumber(row.cachedInputTokens),
        totalTokens: asNumber(row.totalTokens),
        modelContextWindow,
        pressurePercent
    };
}

function readRecentEvents(sessionId: string): PerfRecentEvents {
    const rows = readSqliteJson(hapiDbPath(), `
        SELECT
            MAX(CASE WHEN content_type = 'event' AND data_type = 'ready' THEN seq END) AS readySeq,
            MAX(CASE WHEN data_type = 'context_compacted' THEN seq END) AS contextCompactedSeq,
            MAX(CASE WHEN data_type IN ('task_failed', 'stream_error') THEN seq END) AS failedSeq
        FROM (
            SELECT
                seq,
                json_extract(content, '$.content.type') AS content_type,
                json_extract(content, '$.content.data.type') AS data_type
            FROM messages
            WHERE session_id = ${quoteSql(sessionId)}
            ORDER BY seq DESC
            LIMIT 300
        );
    `);
    const row = rows[0] ?? {};
    return {
        readySeq: asNumber(row.readySeq),
        contextCompactedSeq: asNumber(row.contextCompactedSeq),
        failedSeq: asNumber(row.failedSeq)
    };
}

function getDescendantPids(rootPid: number, processes: ProcessInfo[]): Set<number> {
    const childrenByParent = new Map<number, ProcessInfo[]>();
    for (const processInfo of processes) {
        if (typeof processInfo.ppid !== 'number') {
            continue;
        }
        const children = childrenByParent.get(processInfo.ppid) ?? [];
        children.push(processInfo);
        childrenByParent.set(processInfo.ppid, children);
    }

    const descendants = new Set<number>();
    const stack = [...(childrenByParent.get(rootPid) ?? [])];
    while (stack.length > 0) {
        const child = stack.pop();
        if (!child || descendants.has(child.pid)) {
            continue;
        }
        descendants.add(child.pid);
        stack.push(...(childrenByParent.get(child.pid) ?? []));
    }
    return descendants;
}

function isCodexAppServerProcess(processInfo: ProcessInfo): boolean {
    const text = `${processInfo.name ?? ''} ${processInfo.cmd ?? ''}`;
    return text.includes('codex app-server');
}

function isHapiCliProcess(processInfo: ProcessInfo): boolean {
    const text = `${processInfo.name ?? ''} ${processInfo.cmd ?? ''}`;
    return text.includes('/hapi-source/cli/') || text.includes('\\hapi-source\\cli\\') || text.includes('--started-by runner');
}

function hasProcessAncestor(pid: number, processesByPid: Map<number, ProcessInfo>, predicate: (processInfo: ProcessInfo) => boolean): boolean {
    const seen = new Set<number>();
    let current = processesByPid.get(pid);
    while (current && !seen.has(current.pid)) {
        seen.add(current.pid);
        if (predicate(current)) {
            return true;
        }
        current = typeof current.ppid === 'number' ? processesByPid.get(current.ppid) : undefined;
    }
    return false;
}

function inferBackendKind(session: Pick<ApiSession, 'model' | 'metadata'>): PerfBackendKind {
    const flavor = session.metadata?.flavor;
    if (flavor === 'agy') {
        return 'agy';
    }
    if (flavor === 'grok') {
        return 'grok';
    }
    if (flavor === 'codex') {
        return 'codex';
    }
    if (flavor === 'claude' || flavor === 'claude-deepseek' || flavor === 'claude-ark' || flavor === 'cc-api') {
        return 'claude';
    }

    const model = (session.model ?? '').toLowerCase();
    if (model.includes('agy')) {
        return 'agy';
    }
    if (
        model.includes('claude') ||
        model.includes('opus') ||
        model.includes('sonnet') ||
        model.includes('haiku')
    ) {
        return 'claude';
    }
    if (model) {
        return 'codex';
    }
    return 'unknown';
}

function isClaudeCliProcess(processInfo: ProcessInfo): boolean {
    const name = (processInfo.name ?? '').trim();
    const cmd = (processInfo.cmd ?? '').trim();
    if (cmd.includes('/Applications/Claude.app/')) {
        return false;
    }
    return name === 'claude' || cmd === 'claude' || cmd.startsWith('claude ') || /\/claude(\s|$)/.test(cmd);
}

function isAgyCliProcess(processInfo: ProcessInfo): boolean {
    const name = (processInfo.name ?? '').trim();
    const cmd = (processInfo.cmd ?? '').trim();
    return name === 'agy' || cmd === 'agy' || cmd.startsWith('agy ') || /\/agy(\s|$)/.test(cmd);
}

function isGrokCliProcess(processInfo: ProcessInfo): boolean {
    const name = (processInfo.name ?? '').trim();
    const cmd = (processInfo.cmd ?? '').trim();
    return name === 'grok' || cmd === 'grok' || cmd.startsWith('grok ') || /\/grok(\s|$)/.test(cmd);
}

function isBackendProcess(processInfo: ProcessInfo, backendKind: PerfBackendKind): boolean {
    if (backendKind === 'codex') {
        return isCodexAppServerProcess(processInfo);
    }
    if (backendKind === 'claude') {
        return isClaudeCliProcess(processInfo);
    }
    if (backendKind === 'agy') {
        return isAgyCliProcess(processInfo);
    }
    if (backendKind === 'grok') {
        return isGrokCliProcess(processInfo);
    }
    return false;
}

function backendMissingWarning(backendKind: PerfBackendKind): string | null {
    if (backendKind === 'codex') {
        return 'runner session has no Codex app-server child';
    }
    if (backendKind === 'claude') {
        return 'runner session has no Claude child';
    }
    if (backendKind === 'agy') {
        return 'runner session has no Antigravity agy child';
    }
    if (backendKind === 'grok') {
        return 'runner session has no Grok ACP child';
    }
    return null;
}

function sessionWarnings(session: {
    active: boolean;
    thinking: boolean;
    pendingRequestsCount: number;
    runnerPid: number | null;
    backendKind: PerfBackendKind;
    backendProcessPids: number[];
    appServerPids: number[];
    token: PerfTokenSnapshot | null;
    recent: PerfRecentEvents;
}): string[] {
    const warnings: string[] = [];
    if (session.active && !session.runnerPid) {
        warnings.push('active session is not tracked by runner');
    }
    const missingBackendWarning = backendMissingWarning(session.backendKind);
    const backendShouldBeRunning = session.backendKind === 'codex' || session.thinking || session.pendingRequestsCount > 0;
    if (session.runnerPid && missingBackendWarning && backendShouldBeRunning && session.backendProcessPids.length === 0) {
        warnings.push(missingBackendWarning);
    }
    if (session.token?.pressurePercent !== null && session.token?.pressurePercent !== undefined && session.token.pressurePercent >= 80) {
        warnings.push(`token pressure ${session.token.pressurePercent}%`);
    }
    if (!session.thinking && session.recent.contextCompactedSeq && (!session.recent.readySeq || session.recent.contextCompactedSeq > session.recent.readySeq)) {
        warnings.push('context_compacted appears after last ready');
    }
    if (session.recent.failedSeq) {
        warnings.push(`recent failure at seq ${session.recent.failedSeq}`);
    }
    return warnings;
}

export async function collectPerfSnapshot(options: DoctorPerfOptions = {}): Promise<PerfSnapshot> {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const [runnerState, runnerSessionsResult, processesResult, apiSessionsResult] = await Promise.allSettled([
        readRunnerState(),
        listRunnerSessions(),
        psList() as Promise<ProcessInfo[]>,
        fetchApiSessions()
    ]);

    const runnerStateValue = runnerState.status === 'fulfilled' ? runnerState.value : null;
    const runnerSessions = runnerSessionsResult.status === 'fulfilled' ? runnerSessionsResult.value : [];
    const processes = processesResult.status === 'fulfilled' ? processesResult.value : [];
    const apiSessions = apiSessionsResult.status === 'fulfilled' ? apiSessionsResult.value : [];
    const runnerBySessionId = new Map<string, number>();
    for (const runnerSession of runnerSessions) {
        if (typeof runnerSession?.happySessionId === 'string' && typeof runnerSession?.pid === 'number') {
            runnerBySessionId.set(runnerSession.happySessionId, runnerSession.pid);
        }
    }

    const processByPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
    const descendantsByRunnerPid = new Map<number, Set<number>>();
    const trackedDescendants = new Set<number>();
    for (const runnerSession of runnerSessions) {
        if (typeof runnerSession?.pid !== 'number') {
            continue;
        }
        const descendants = getDescendantPids(runnerSession.pid, processes);
        descendantsByRunnerPid.set(runnerSession.pid, descendants);
        for (const pid of descendants) {
            trackedDescendants.add(pid);
        }
    }

    const sessionRows = apiSessions
        .filter((session): session is ApiSession & { id: string } => typeof session.id === 'string')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, limit)
        .map((session) => {
            const runnerPid = runnerBySessionId.get(session.id) ?? null;
            const descendants = runnerPid ? descendantsByRunnerPid.get(runnerPid) ?? new Set<number>() : new Set<number>();
            const descendantProcesses = [...descendants]
                .map((pid) => processByPid.get(pid))
                .filter((processInfo): processInfo is ProcessInfo => Boolean(processInfo));
            const appServerPids = descendantProcesses
                .filter(isCodexAppServerProcess)
                .map((processInfo) => processInfo.pid)
                .sort((a, b) => a - b);
            const backendKind = inferBackendKind(session);
            const backendProcessPids = descendantProcesses
                .filter((processInfo) => isBackendProcess(processInfo, backendKind))
                .map((processInfo) => processInfo.pid)
                .sort((a, b) => a - b);
            const token = readTokenSnapshot(session.id);
            const recent = readRecentEvents(session.id);
            const base = {
                id: session.id,
                title: session.metadata?.title ?? session.title ?? 'untitled',
                active: session.active === true,
                thinking: session.thinking === true,
                pendingRequestsCount: typeof session.pendingRequestsCount === 'number' ? session.pendingRequestsCount : 0,
                updatedAt: asNumber(session.updatedAt),
                seq: asNumber(session.seq),
                codexSessionId: session.metadata?.codexSessionId ?? null,
                runnerPid,
                backendKind,
                backendProcessPids,
                appServerPids,
                model: session.model ?? null,
                modelReasoningEffort: session.modelReasoningEffort ?? null,
                token,
                recent
            };
            return {
                ...base,
                warnings: sessionWarnings(base)
            };
        });

    const appServerPids = processes
        .filter(isCodexAppServerProcess)
        .map((processInfo) => processInfo.pid);
    const runnerPids = new Set(runnerSessions.map((session) => session.pid).filter((pid): pid is number => typeof pid === 'number'));
    const untrackedCandidateAppServerPids = appServerPids
        .filter((pid) => !trackedDescendants.has(pid) && !runnerPids.has(pid))
        .sort((a, b) => a - b);
    const untrackedAppServerPids = untrackedCandidateAppServerPids
        .filter((pid) => hasProcessAncestor(pid, processByPid, isHapiCliProcess));
    const externalAppServerPids = untrackedCandidateAppServerPids
        .filter((pid) => !hasProcessAncestor(pid, processByPid, isHapiCliProcess));
    const warnings: string[] = [];
    if (untrackedAppServerPids.length > 0) {
        warnings.push(`${untrackedAppServerPids.length} untracked HAPI Codex app-server process${untrackedAppServerPids.length === 1 ? '' : 'es'}`);
    }

    return {
        generatedAt: new Date().toISOString(),
        runner: {
            running: Boolean(runnerStateValue?.pid),
            pid: runnerStateValue?.pid ?? null,
            sessions: runnerSessions.length
        },
        sessions: sessionRows,
        untrackedAppServerPids,
        externalAppServerPids,
        warnings
    };
}

function formatToken(token: PerfTokenSnapshot | null): string {
    if (!token?.lastTotalTokens) {
        return 'tokens n/a';
    }
    if (token.modelContextWindow && token.pressurePercent !== null) {
        return `tokens last=${token.lastTotalTokens}/${token.modelContextWindow} (${token.pressurePercent}%)`;
    }
    return `tokens last=${token.lastTotalTokens}`;
}

function formatRecent(recent: PerfRecentEvents): string {
    return `events ready=${recent.readySeq ?? 'none'} compact=${recent.contextCompactedSeq ?? 'none'} failed=${recent.failedSeq ?? 'none'}`;
}

export function formatPerfReport(snapshot: PerfSnapshot): string {
    const busyCount = snapshot.sessions.filter((session) => session.thinking || session.pendingRequestsCount > 0).length;
    const lines = [
        'hapi doctor perf',
        `Generated: ${snapshot.generatedAt}`,
        `Runner: ${snapshot.runner.running ? 'running' : 'not running'} pid=${snapshot.runner.pid ?? 'none'} sessions=${snapshot.runner.sessions}`,
        `Busy: ${busyCount}/${snapshot.sessions.length}`,
        ''
    ];

    if (snapshot.sessions.length === 0) {
        lines.push('No sessions returned by HAPI API.');
    } else {
        lines.push('Sessions:');
        for (const session of snapshot.sessions) {
            const status = session.thinking ? 'thinking' : 'idle';
            const backendPids = session.backendProcessPids.length > 0
                ? session.backendProcessPids.join(',')
                : 'none';
            lines.push(`- ${session.title} (${session.id}) ${status} pending=${session.pendingRequestsCount} pid=${session.runnerPid ?? 'none'} backend=${session.backendKind}:${backendPids} appServer=${session.appServerPids.join(',') || 'none'}`);
            lines.push(`  ${formatToken(session.token)} total=${session.token?.totalTokens ?? 'n/a'}`);
            lines.push(`  ${formatRecent(session.recent)}`);
            if (session.warnings.length > 0) {
                lines.push(`  warnings: ${session.warnings.join('; ')}`);
            }
        }
    }

    if (snapshot.untrackedAppServerPids.length > 0) {
        lines.push('');
        lines.push(`Untracked HAPI app-server PIDs: ${snapshot.untrackedAppServerPids.join(', ')}`);
    }
    if (snapshot.externalAppServerPids.length > 0) {
        lines.push('');
        lines.push(`External Codex app-server PIDs: ${snapshot.externalAppServerPids.join(', ')}`);
    }
    if (snapshot.warnings.length > 0) {
        lines.push('');
        lines.push(`Warnings: ${snapshot.warnings.join('; ')}`);
    }

    return lines.join('\n');
}

export async function runDoctorPerf(options: DoctorPerfOptions = {}): Promise<void> {
    const snapshot = await collectPerfSnapshot(options);
    if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
    }
    console.log(chalk.cyan(formatPerfReport(snapshot)));
}
