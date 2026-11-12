/**
 * Out-of-process runner watchdog.
 *
 * Background (2026-11-11 load storm): the runner's Bun event loop was starved
 * for 39 minutes while the process stayed alive — zero heartbeats, zero logs,
 * no reconnects. Every in-process supervisor shares the frozen loop, and even
 * `hapi runner stop` hung, so nothing short of walking up to the machine
 * could recover it. The mitigation is deliberately out-of-process:
 *
 * 1. The runner refreshes a heartbeat file (<hapi-home>/runner-heartbeat) at
 *    the very top of every heartbeat tick, before any await/network work — so
 *    the file only goes stale when the event loop itself is frozen. The
 *    file's second line records whether the runner is supervised
 *    (HAPI_RUNNER_SUPERVISED=1) and its third line the runner's pid.
 * 2. A macOS LaunchAgent runs a pure-bash watchdog script every 60s. If the
 *    heartbeat is stale while its recorded pid still looks like a live
 *    `hapi runner start` process AND the runner advertised a supervisor, the
 *    script kill -9's that exact pid so the external guard can respawn a
 *    fresh runner. An unsupervised runner is never killed: nothing would
 *    restart it, so the kill would trade a frozen-but-recoverable machine
 *    for an offline one.
 *
 * Per-instance scoping: every piece of watchdog state (heartbeat file,
 * script, launchd label, kill victim) is keyed to the runner's HAPI_HOME.
 * Concurrent runner instances always live in different HAPI_HOMEs (the
 * per-home runner lock forces a same-home duplicate to exit), so the
 * resolved home is the instance key. The default single-instance setup
 * (HAPI_HOME unset) keeps the historical ~/.hapi paths and the unsuffixed
 * com.hapi.watchdog label; a custom HAPI_HOME gets a short-hash-suffixed
 * label and state inside its own home, so one instance's heartbeat can
 * never satisfy — or arm a kill against — another instance's watchdog.
 *
 * Everything here is best-effort by contract: a watchdog failure must never
 * block or crash the runner it is supposed to protect.
 */
import { execFile } from 'child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'os';
import { dirname, join } from 'node:path';
import { resolveHapiHomeDir } from '@/configuration';
import { logger } from '@/ui/logger';

export const WATCHDOG_LABEL = 'com.hapi.watchdog';
export const WATCHDOG_STALE_SECONDS = 300;
export const WATCHDOG_RUNNER_PATTERN = 'hapi runner start';
export const WATCHDOG_INTERVAL_SECONDS = 60;

/**
 * Short stable suffix isolating watchdog state between runner instances.
 * Empty for the default setup (HAPI_HOME unset) so names, paths and the
 * launchd label stay exactly as they were; a short sha256 prefix of the
 * resolved home otherwise (long enough to avoid collisions between
 * concurrent homes, short enough for launchd labels and file names).
 */
export function watchdogInstanceSuffix(env: NodeJS.ProcessEnv = process.env): string {
    if (!env.HAPI_HOME) {
        return '';
    }
    const digest = createHash('sha256').update(resolveHapiHomeDir(env)).digest('hex');
    return `-${digest.slice(0, 8)}`;
}

/** launchd label of this runner instance's watchdog LaunchAgent. */
export function watchdogLabel(env: NodeJS.ProcessEnv = process.env): string {
    return `${WATCHDOG_LABEL}${watchdogInstanceSuffix(env)}`;
}

/**
 * Path of the heartbeat file watched by the out-of-process watchdog. Lives
 * inside the runner's own HAPI_HOME (same resolution as the runner state
 * file) so concurrent instances never share a heartbeat: a fresh heartbeat
 * from instance A must not keep instance B's watchdog satisfied.
 */
export function runnerHeartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(resolveHapiHomeDir(env), 'runner-heartbeat');
}

/**
 * Refresh the heartbeat file with the current epoch milliseconds. Called
 * unconditionally at the top of every heartbeat tick and once at startup, so
 * a fresh file means "the event loop is alive". The second line records
 * whether THIS runner is supervised (HAPI_RUNNER_SUPERVISED=1): the
 * out-of-process watchdog only kills a frozen runner that advertised a
 * supervisor which will respawn it — killing an unsupervised (default
 * detached) runner would take the machine offline with nothing to restart
 * it. Because every runner rewrites the whole file on every tick, a later
 * unsupervised runner overwrites a stale supervised marker before it can
 * authorize a kill. The third line records THIS runner's pid so the
 * watchdog's victim selection is exact (see buildWatchdogScript) instead of
 * guessing among every `hapi runner start` process on the machine.
 * Best-effort: a failed write falls back to a utimes touch (mtime refresh),
 * and a failed touch is ignored — the watchdog must never take the runner
 * down with it.
 */
export function touchRunnerHeartbeat(
    now: number = Date.now(),
    supervised: boolean = process.env.HAPI_RUNNER_SUPERVISED === '1',
    pid: number = process.pid
): void {
    const heartbeatPath = runnerHeartbeatPath();
    try {
        writeFileSync(heartbeatPath, `${now}\n${supervised ? 'supervised' : 'unsupervised'}\n${pid}\n`);
        return;
    } catch {
        // Fall through to the utimes touch below.
    }
    try {
        const stamp = new Date(now);
        utimesSync(heartbeatPath, stamp, stamp);
    } catch {
        // Give up silently — the watchdog is best-effort only.
    }
}

/**
 * Best-effort removal of the heartbeat file on graceful shutdown. Without
 * this, a cleanly stopped supervised runner would leave a forever-stale
 * 'supervised' claim behind; combined with OS pid reuse that stale claim
 * could later authorize killing an unrelated runner process that happens to
 * have recycled the recorded pid. Never throws: shutdown must not break
 * over the watchdog.
 */
export function clearRunnerHeartbeat(): void {
    try {
        rmSync(runnerHeartbeatPath(), { force: true });
    } catch {
        // Best-effort only.
    }
}

/** Single-quote a value for safe interpolation into the bash script. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escape a value for interpolation into the LaunchAgent plist XML. */
function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export interface WatchdogScriptOptions {
    heartbeatPath: string;
    staleSeconds?: number;
    logPath: string;
    runnerPattern?: string;
    label?: string;
}

/**
 * Generate the pure-bash watchdog script. No Bun/Node dependency: it has to
 * run (and kill) even when every HAPI process on the machine is frozen.
 */
export function buildWatchdogScript(opts: WatchdogScriptOptions): string {
    const staleSeconds = opts.staleSeconds ?? WATCHDOG_STALE_SECONDS;
    const runnerPattern = opts.runnerPattern ?? WATCHDOG_RUNNER_PATTERN;
    const label = opts.label ?? WATCHDOG_LABEL;
    return `#!/bin/bash
# Generated by hapi (${label}) — do not edit.
# Kills the runner when its heartbeat file goes stale while the process is
# still alive (frozen event loop); the external guard respawns a fresh one.
# Every path here is scoped to one runner instance (its HAPI_HOME), and the
# kill victim is the pid the runner recorded in its own heartbeat.
set -u

HEARTBEAT=${shellQuote(opts.heartbeatPath)}
STALE_SECONDS=${staleSeconds}
RUNNER_PATTERN=${shellQuote(runnerPattern)}
LOG_PATH=${shellQuote(opts.logPath)}

# Runner never started on this machine — nothing to watch.
if [ ! -f "$HEARTBEAT" ]; then
  exit 0
fi

# File mtime in epoch seconds. BSD (darwin) and GNU (linux) stat disagree on
# flags: probe the darwin form first — on linux \`stat -f\` enters file-system
# mode where %m is not a valid directive, so the probe fails and we fall
# through to the GNU form.
if stat -f %m "$HEARTBEAT" >/dev/null 2>&1; then
  mtime=$(stat -f %m "$HEARTBEAT")
else
  mtime=$(stat -c %Y "$HEARTBEAT")
fi

now=$(date +%s)
age=$((now - mtime))
if [ "$age" -lt "$STALE_SECONDS" ]; then
  exit 0
fi

# No live runner process means a clean stop — that is the guard's business.
pids=$(pgrep -f "$RUNNER_PATTERN" 2>/dev/null || true)
if [ -z "$pids" ]; then
  exit 0
fi

# Destructive recovery only for supervised runners. The kill assumes an
# external supervisor (launchd KeepAlive, pm2, systemd, guard script) will
# respawn a fresh runner afterwards — that promise is exactly what
# HAPI_RUNNER_SUPERVISED=1 advertises, and the runner rewrites it into the
# heartbeat file's second line on every tick. An unsupervised (default
# detached) runner must be left alone: killing it would take the machine
# offline with nothing to restart it, and the rewrite above guarantees a
# stale supervised marker from an earlier runner cannot authorize this kill.
supervision=$(sed -n '2p' "$HEARTBEAT" 2>/dev/null | tr -d '[:space:]')
if [ "$supervision" != "supervised" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') stale runner heartbeat: age=\${age}s but the runner is unsupervised; leaving recovery to the operator" >> "$LOG_PATH" 2>/dev/null || true
  exit 0
fi

# Victim selection must be instance-exact: the heartbeat's third line
# records the pid of the runner that owns THIS heartbeat file. A bare
# \`pgrep -f\` matches every \`hapi runner start\` process on the machine —
# including runner instances from other HAPI_HOMEs — so killing the oldest
# pgrep hit could kill the wrong instance. Only kill the recorded pid, and
# only while it still matches the runner pattern (guards against OS pid
# reuse). An unknown, exited or reused pid is never substituted with a
# guess: skip and let the guard do its job.
pid=$(sed -n '3p' "$HEARTBEAT" 2>/dev/null | tr -d '[:space:]')
if [ -z "$pid" ] || [ -z "$(printf '%s\\n' "$pids" | grep -Fx "$pid")" ]; then
  exit 0
fi
if [ "$pid" = "$$" ]; then
  exit 0
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') stale runner heartbeat: age=\${age}s pid=\${pid} pattern=\${RUNNER_PATTERN}, sending kill -9" >> "$LOG_PATH" 2>/dev/null || true
kill -9 "$pid" 2>/dev/null || true
exit 0
`;
}

export interface WatchdogPlistOptions {
    scriptPath: string;
    intervalSeconds?: number;
    label?: string;
}

/**
 * Generate the macOS LaunchAgent plist that runs the watchdog script on a
 * fixed interval (plus once at login). The label is per runner instance so
 * concurrent instances (different HAPI_HOMEs) each get their own agent.
 */
export function buildWatchdogPlist(opts: WatchdogPlistOptions): string {
    const intervalSeconds = opts.intervalSeconds ?? WATCHDOG_INTERVAL_SECONDS;
    const label = opts.label ?? WATCHDOG_LABEL;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xmlEscape(opts.scriptPath)}</string>
    </array>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`;
}

export type WatchdogInstallResult = 'installed' | 'disabled' | 'skipped';

function readFileIfExists(path: string): string | undefined {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return undefined;
    }
}

/** launchctl invocation that never throws; output is swallowed. */
function runLaunchctl(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            execFile('launchctl', args, { timeout: 15_000 }, (error) => {
                resolve(!error);
            });
        } catch {
            resolve(false);
        }
    });
}

/**
 * Install (or refresh) the watchdog LaunchAgent. Best-effort by contract:
 * every failure is swallowed and logged at debug level so the watchdog can
 * never block or break runner startup.
 *
 * - HAPI_RUNNER_WATCHDOG=0 → 'disabled' (operator opt-out)
 * - non-darwin platforms → 'skipped'
 */
export async function ensureWatchdogInstalled(): Promise<WatchdogInstallResult> {
    try {
        if (process.env.HAPI_RUNNER_WATCHDOG === '0') {
            logger.debug('[RUNNER WATCHDOG] Disabled via HAPI_RUNNER_WATCHDOG=0');
            return 'disabled';
        }
        if (process.platform !== 'darwin') {
            // TODO: Linux — install a systemd user timer (or @reboot cron
            // entry) running the same watchdog script. Tracked for a
            // follow-up; until then Linux relies on the guard alone.
            logger.debug(`[RUNNER WATCHDOG] Skipped on platform ${process.platform} (darwin-only for now)`);
            return 'skipped';
        }

        // Per-instance state: everything lives inside the runner's own
        // HAPI_HOME (same resolution as the runner state file), and the
        // launchd label carries a short hash of that home so concurrent
        // instances never fight over one agent. With HAPI_HOME unset the
        // historical ~/.hapi paths and com.hapi.watchdog label are kept.
        const home = os.homedir();
        const hapiHome = resolveHapiHomeDir();
        const label = watchdogLabel();
        const logDir = join(hapiHome, 'logs');
        mkdirSync(logDir, { recursive: true });

        // The stale threshold must always leave room for a healthy runner:
        // when the operator slows the in-process heartbeat
        // (HAPI_RUNNER_HEARTBEAT_INTERVAL) past the default cadence, widen the
        // window instead of kill-looping a slow-but-healthy runner.
        const heartbeatIntervalMs = Number.parseInt(
            process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL || '60000',
            10
        );
        const staleSeconds = Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 120_000
            ? Math.ceil(heartbeatIntervalMs / 1000) + WATCHDOG_STALE_SECONDS
            : WATCHDOG_STALE_SECONDS;

        const scriptPath = join(hapiHome, 'watchdog.sh');
        const script = buildWatchdogScript({
            heartbeatPath: runnerHeartbeatPath(),
            staleSeconds,
            logPath: join(logDir, 'watchdog.log'),
            runnerPattern: WATCHDOG_RUNNER_PATTERN,
            label
        });
        // Rewrite only on content change so a restarted runner does not
        // churn the file (or the launchd definition) unnecessarily.
        if (readFileIfExists(scriptPath) !== script) {
            writeFileSync(scriptPath, script);
        }
        chmodSync(scriptPath, 0o755);

        // Upgrade transition: a runner from before per-instance scoping may
        // have left a default-home script whose pgrep-oldest victim logic
        // can no longer be trusted on a multi-instance machine. Rewrite the
        // default-home script with the pid-exact form — it is inert unless
        // a runner actually owns the default home (no heartbeat file → exit
        // 0; pre-scoping heartbeats carry no pid line → no victim → exit
        // 0), and a live default-home runner rewrites the same content
        // anyway. Never removes the default label itself: a concurrent
        // default-home instance owns it.
        if (label !== WATCHDOG_LABEL) {
            try {
                const defaultHome = resolveHapiHomeDir({ ...process.env, HAPI_HOME: undefined });
                if (defaultHome !== hapiHome) {
                    const defaultScriptPath = join(defaultHome, 'watchdog.sh');
                    const defaultScript = buildWatchdogScript({
                        heartbeatPath: join(defaultHome, 'runner-heartbeat'),
                        staleSeconds,
                        logPath: join(defaultHome, 'logs', 'watchdog.log'),
                        runnerPattern: WATCHDOG_RUNNER_PATTERN
                    });
                    if (readFileIfExists(defaultScriptPath) !== defaultScript) {
                        writeFileSync(defaultScriptPath, defaultScript);
                        chmodSync(defaultScriptPath, 0o755);
                    }
                }
            } catch (error) {
                logger.debug('[RUNNER WATCHDOG] Default-home script refresh failed (continuing anyway)', error);
            }
        }

        const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
        mkdirSync(dirname(plistPath), { recursive: true });
        const plist = buildWatchdogPlist({ scriptPath, intervalSeconds: WATCHDOG_INTERVAL_SECONDS, label });
        if (readFileIfExists(plistPath) !== plist) {
            writeFileSync(plistPath, plist);
        }

        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        // bootout first so launchctl reloads a possibly-changed plist
        // definition; "not loaded" errors are expected and ignored.
        await runLaunchctl(['bootout', `gui/${uid}`, plistPath]);
        const bootstrapped = await runLaunchctl(['bootstrap', `gui/${uid}`, plistPath]);
        if (!bootstrapped) {
            logger.debug(`[RUNNER WATCHDOG] launchctl bootstrap did not report success (continuing anyway): ${plistPath}`);
            return 'skipped';
        }
        logger.debug(`[RUNNER WATCHDOG] LaunchAgent ${label} installed (${plistPath})`);
        return 'installed';
    } catch (error) {
        // Best-effort by contract — never break runner startup over the watchdog.
        logger.debug('[RUNNER WATCHDOG] Installation failed (continuing without watchdog)', error);
        return 'skipped';
    }
}
