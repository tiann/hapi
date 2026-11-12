import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildWatchdogScript } from './watchdog';

// End-to-end behavior tests for the GENERATED watchdog script: the real
// bash file runs against a controlled fake process table (pgrep/ps are
// PATH-shimmed; stat/date/sed/grep are the host utilities) and kills real,
// harmless `sleep` children standing in for frozen runners. These lock the
// kill / no-kill decision for every heartbeat format:
//
// - legacy (pre per-instance-scoping) heartbeats must still be killed by
//   the default home's transition script — the upgrade transition must not
//   silently disarm the watchdog protecting a still-running old runner;
// - pid-claim heartbeats are killed exactly and only when the recorded pid
//   still matches the runner pattern AND its recorded process start time
//   (generation marker) still describes the live process.

const LSTART_RECORDED = 'Mon Nov  3 09:12:34 2026';
const LSTART_RECYCLED = 'Tue Nov 10 08:00:00 2026';

let workDir: string;
let shimDir: string;
let heartbeatPath: string;
let logPath: string;
let scriptPath: string;
let pgrepFile: string;
let psFile: string;

/** Single-quote a value for safe interpolation into a shim script. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeShim(name: string, body: string): void {
    const shimPath = join(shimDir, name);
    writeFileSync(shimPath, `#!/bin/bash\n${body}\n`);
    chmodSync(shimPath, 0o755);
}

function writeHeartbeat(content: string, ageSeconds: number): void {
    writeFileSync(heartbeatPath, content);
    const stamp = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(heartbeatPath, stamp, stamp);
}

function writeScript(content: string): void {
    writeFileSync(scriptPath, content);
}

function runWatchdog(): void {
    execFileSync('/bin/bash', [scriptPath], {
        env: { ...process.env, PATH: `${shimDir}:/usr/bin:/bin:/usr/sbin:/sbin` },
        stdio: 'ignore'
    });
}

function watchdogLog(): string {
    try {
        return readFileSync(logPath, 'utf8');
    } catch {
        return '';
    }
}

const children: ChildProcess[] = [];

/** A live, harmless stand-in for a frozen runner process. */
function spawnFrozenRunner(): number {
    const child = spawn('sleep', ['120'], { stdio: 'ignore' });
    children.push(child);
    expect(child.pid).toBeGreaterThan(0);
    return child.pid!;
}

interface ExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
}

function exitInfo(child: ChildProcess): ExitInfo | null {
    if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
    }
    return null;
}

async function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<ExitInfo | null> {
    const immediate = exitInfo(child);
    if (immediate) {
        return immediate;
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}

function childOf(pid: number): ChildProcess {
    const child = children.find((c) => c.pid === pid);
    expect(child).toBeDefined();
    return child!;
}

async function expectKilled(pid: number): Promise<void> {
    const info = await waitForExit(childOf(pid));
    expect(info?.signal).toBe('SIGKILL');
    expect(watchdogLog()).toContain('sending kill -9');
}

async function expectSpared(pid: number, expectedLog?: string | RegExp): Promise<void> {
    // Give a would-be kill time to surface as an exit event before asserting
    // the process survived.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const child = childOf(pid);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    if (expectedLog !== undefined) {
        if (typeof expectedLog === 'string') {
            expect(watchdogLog()).toContain(expectedLog);
        } else {
            expect(watchdogLog()).toMatch(expectedLog);
        }
    }
}

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'hapi-watchdog-script-'));
    shimDir = join(workDir, 'shim');
    mkdirSync(shimDir, { recursive: true });
    const logDir = join(workDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    heartbeatPath = join(workDir, 'runner-heartbeat');
    logPath = join(logDir, 'watchdog.log');
    scriptPath = join(workDir, 'watchdog.sh');
    pgrepFile = join(workDir, 'pgrep.out');
    psFile = join(workDir, 'ps.out');
    writeShim('pgrep', `cat ${shellQuote(pgrepFile)}`);
    writeShim('ps', `cat ${shellQuote(psFile)}`);
});

afterEach(() => {
    for (const child of children) {
        try {
            child.kill('SIGKILL');
        } catch {
            // Already gone.
        }
    }
    children.length = 0;
    rmSync(logPath, { force: true });
});

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('watchdog script kill decisions', () => {
    it('kills the oldest runner process for a stale legacy supervised heartbeat (transition script)', async () => {
        // The regression this locks: a pre-scoping default-home runner writes
        // two-line heartbeats (timestamp + supervision claim, no pid line).
        // The upgraded default-home script must still recover it — 300s
        // stale + live process + supervised → kill, exactly like the
        // pre-scoping script did.
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n`, 400);
        writeScript(buildWatchdogScript({
            heartbeatPath,
            logPath,
            legacyHeartbeatVictimFallback: true
        }));

        runWatchdog();

        await expectKilled(pid);
    });

    it('never kills an unsupervised legacy runner', async () => {
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nunsupervised\n`, 400);
        writeScript(buildWatchdogScript({
            heartbeatPath,
            logPath,
            legacyHeartbeatVictimFallback: true
        }));

        runWatchdog();

        await expectSpared(pid, 'unsupervised; leaving recovery to the operator');
    });

    it('does not kill while the heartbeat is fresh', async () => {
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n`, 100);
        writeScript(buildWatchdogScript({
            heartbeatPath,
            logPath,
            legacyHeartbeatVictimFallback: true
        }));

        runWatchdog();

        await expectSpared(pid);
        expect(watchdogLog()).toBe('');
    });

    it('honors a preserved widened threshold in the transition script', async () => {
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n`, 400);
        writeScript(buildWatchdogScript({
            heartbeatPath,
            logPath,
            staleSeconds: 900,
            legacyHeartbeatVictimFallback: true
        }));

        runWatchdog();

        // 400s stale under a preserved 900s window: still healthy.
        await expectSpared(pid);
    });

    it('never falls back to pgrep-oldest for a script without the legacy option', async () => {
        // A home owned by a current runner: a pid-less heartbeat means
        // "cannot identify the victim" — skip, never guess.
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n`, 400);
        writeScript(buildWatchdogScript({ heartbeatPath, logPath }));

        runWatchdog();

        await expectSpared(pid);
        expect(watchdogLog()).toBe('');
    });

    it('kills exactly the recorded pid when its generation still matches', async () => {
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n${pid}\n${LSTART_RECORDED}\n`, 400);
        writeScript(buildWatchdogScript({ heartbeatPath, logPath }));

        runWatchdog();

        await expectKilled(pid);
    });

    it('refuses to kill a recycled pid whose start time no longer matches', async () => {
        // The recorded pid was reused by a different process between the
        // freeze and this run: same pid, different generation — the claim
        // must not authorize the kill.
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECYCLED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n${pid}\n${LSTART_RECORDED}\n`, 400);
        writeScript(buildWatchdogScript({ heartbeatPath, logPath }));

        runWatchdog();

        await expectSpared(pid, /pid reuse\); not killing/);
        expect(watchdogLog()).toContain(LSTART_RECORDED);
        expect(watchdogLog()).toContain(LSTART_RECYCLED);
    });

    it('still kills a pid-claim heartbeat without a generation marker', async () => {
        // Three-line heartbeats (pid but no start time, as written by the
        // first per-instance-scoping runners) and markers that cannot be
        // re-queried degrade to the pattern-membership check, not to
        // "never kill": a failed ps must not disable recovery.
        const pid = spawnFrozenRunner();
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECYCLED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n${pid}\n`, 400);
        writeScript(buildWatchdogScript({ heartbeatPath, logPath }));

        runWatchdog();

        await expectKilled(pid);
    });

    it('does not kill when the recorded pid is no longer a runner process', async () => {
        const pid = spawnFrozenRunner();
        // pgrep sees a different runner; the recorded claim points elsewhere.
        writeFileSync(pgrepFile, `${pid}\n`);
        writeFileSync(psFile, `${LSTART_RECORDED}\n`);
        writeHeartbeat(`1700000000000\nsupervised\n${pid + 1}\n${LSTART_RECORDED}\n`, 400);
        writeScript(buildWatchdogScript({ heartbeatPath, logPath }));

        runWatchdog();

        await expectSpared(pid);
        expect(watchdogLog()).toBe('');
    });
});
