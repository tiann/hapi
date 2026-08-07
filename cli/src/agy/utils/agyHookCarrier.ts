import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { resolveHapiHomeDir } from '@/configuration';

export type AgyHookCarrier = {
    carrierDir: string;
};

export type AgyMcpServerEntry = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};

// `scope` is the over-delete guard for a shared HAPI_HOME (Fix N6, hardened
// further below): a devcontainer bind-mounting ~/.hapi, or an NFS-shared
// home, puts carriers written by different PID namespaces in the same
// agy-carriers/ directory. A pid recorded by namespace A means nothing in
// namespace B — probing it there can hit ESRCH for a process that is very
// much alive in A.
//
// hostname alone (the original Fix N6) does not close this: two containers
// sharing a HAPI_HOME typically also share a hostname (or both default to
// the same short container-id-derived one), which is exactly the collision
// this guard exists to prevent. `scope` instead identifies the boot +
// PID-namespace pair a carrier's pid was recorded in on Linux (see
// computeLocalCarrierScope()) or the machine + boot-session pair on macOS
// (see computeLocalCarrierScopeAsync/warmCarrierScope) — which
// distinguishes exactly the cases hostname could not: two containers on the
// same host (different PID namespaces, same boot_id) and the same container
// across a restart (same PID namespace file, but the boot_id — read from
// the host's /proc — differs only across an actual host reboot, which is
// the one case where every previously-recorded pid is unconditionally dead;
// this fix does not attempt to special-case that, see sweepAgyHookCarriers's
// docstring). A platform/environment this module cannot identify at all (a
// restricted /proc that exists but denies these specific reads, a
// failed/timed-out macOS probe, Windows — see computeLocalCarrierScopeAsync's
// docstring for why it stays unsupported — or any other unrecognized
// process.platform) gets no scope and is therefore never swept — hostname
// is not an identity, so there is deliberately no
// fallback to it (see computeLocalCarrierScope/computeLocalCarrierScopeAsync).
type AgyHookCarrierOwner = {
    pid: number;
    scope: string;
};

const AGY_CARRIERS_DIRNAME = 'agy-carriers';
const OWNER_FILE_NAME = 'owner.json';
// Every carrier prepareAgyHookCarrier() creates is mkdtemp'd under this
// prefix (see below). Sweep must never touch a directory that doesn't carry
// it — HAPI_HOME misconfiguration or reuse (pointing an unrelated HAPI_HOME
// at a directory with other content) must never turn into a recursive
// delete of whatever else happens to live there (Fix N3).
const CARRIER_DIR_PREFIX = 'hapi-agy-carrier-';

/**
 * Reads the boot-id + PID-namespace pair that identifies "this exact kernel
 * boot, this exact PID namespace" on Linux. /proc/sys/kernel/random/boot_id
 * is a fresh random UUID generated once per boot (host or container, shared
 * with any container sharing the host's kernel); /proc/self/ns/pid resolves
 * (via its inode number) to a namespace identifier that differs between
 * containers even when they share a boot_id. Together they're a strictly
 * stronger identity than hostname for deciding whether a recorded pid could
 * plausibly mean anything in the CURRENT process's PID space.
 *
 * Returns undefined on any read failure — not just "file missing" (a
 * non-Linux OS) but also a restricted/virtualized /proc that exists but
 * denies these specific reads (some sandboxes) — so the caller has one
 * signal ("could not determine") to fall back on, rather than needing to
 * distinguish failure modes.
 */
function readLinuxBootAndNamespaceScope(probe: Pick<ScopeProbe, 'readBootId' | 'readPidNamespaceId'>): string | undefined {
    try {
        const bootId = probe.readBootId();
        const nsId = probe.readPidNamespaceId();
        if (!bootId || !nsId) return undefined;
        return `linux:${bootId}:${nsId}`;
    } catch {
        return undefined;
    }
}

// Shared by every platform-specific identifier below: a value that "looks
// like an error message" or is truncated must never be woven into a scope
// string (an over-eager regex match on the wrong line of output is the
// realistic failure mode, not total absence of output). Every raw id read
// from an external command is checked against this before use.
const UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

// macOS identity probes are child processes (no /proc equivalent), so they
// get an explicit timeout rather than relying on the caller's own patience —
// sweepAgyHookCarriers's docstring already establishes there is no latency
// budget to protect here (it is a backup path off the session boot path as
// of the previous commit), but an unbounded child process is still a
// leak/hang risk on a wedged system.
const PLATFORM_SCOPE_PROBE_TIMEOUT_MS = 2000;

/**
 * Extracts IOPlatformUUID from `ioreg -rd1 -c IOPlatformExpertDevice` output,
 * e.g. `"IOPlatformUUID" = "D8F7807A-6B93-57A4-9DF2-E9A54FA2E046"`. Returns
 * undefined (never throws) on any format this regex/pattern doesn't
 * recognize, rather than risk feeding a truncated or wrong value into a
 * scope string. Exported as a pure function so its parsing logic is
 * unit-testable against a real captured sample without invoking ioreg.
 */
export function parseIoregPlatformUUID(stdout: string): string | undefined {
    const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Za-z-]+)"/.exec(stdout);
    const uuid = match?.[1];
    return uuid && UUID_PATTERN.test(uuid) ? uuid : undefined;
}

/**
 * Extracts the boot identifier from `sysctl -n kern.bootsessionuuid` output
 * (a bare UUID, e.g. `76A5605C-FF4D-4B31-80D8-239964198B7D\n`).
 *
 * `kern.bootsessionuuid` — not `kern.boottime` — is the macOS analogue of
 * Linux's /proc/sys/kernel/random/boot_id. `kern.boottime` was the original
 * choice (see this repo's history) but was disproven: a live re-measurement
 * 8 days after the first one, on a host that had NOT rebooted in between,
 * showed the value drift by 1.318 seconds (kern.boottime is recomputed from
 * NTP-adjusted wall clock time under the hood, per XNU's
 * clock_get_boottime_microtime() — a short observation window made it look
 * stable). `kern.bootsessionuuid` does not have this problem: it is a
 * random UUID XNU generates once per boot (bsd/kern/kern_sysctl.c) and
 * reuses for the life of that boot session (referenced by
 * osfmk/arm/model_dep.c's panic-log boot session UUID, and by
 * bsd/kern/kern_exec.c's per-boot app hash salt) — this "regenerated once
 * per boot" behavior is inferred from those call sites, not stated in an
 * Apple document, so it is asserted here with that caveat rather than as a
 * documented guarantee.
 */
export function parseSysctlBootSessionUUID(stdout: string): string | undefined {
    const value = stdout.trim();
    return UUID_PATTERN.test(value) ? value : undefined;
}

/**
 * Runs an external identifier probe by absolute path, never through a
 * shell (no quoting concerns, no PATH dependency that could silently
 * resolve to the wrong binary in a reduced/GUI-launcher environment) and
 * with a bounded timeout. Resolves to stdout on a clean exit; rejects
 * (caught by every caller below) on a non-zero exit, a missing binary
 * (ENOENT), or a timeout. `windowsHide` matches this repo's other child-spawn
 * call sites (agyModels.ts, grokModels.ts, ripgrep/index.ts, utils/process.ts,
 * spawnWithAbort.ts, ...) — a no-op on the platforms this function currently
 * runs probes on, kept for when it is reused elsewhere.
 */
function execFileForScopeProbe(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: PLATFORM_SCOPE_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

async function readDarwinMachineIdReal(): Promise<string> {
    const stdout = await execFileForScopeProbe('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const uuid = parseIoregPlatformUUID(stdout);
    if (!uuid) throw new Error('could not parse IOPlatformUUID from ioreg output');
    return uuid;
}

async function readDarwinBootSessionIdReal(): Promise<string> {
    const stdout = await execFileForScopeProbe('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
    const bootSessionId = parseSysctlBootSessionUUID(stdout);
    if (!bootSessionId) throw new Error('unexpected kern.bootsessionuuid format');
    return bootSessionId;
}

/**
 * Dependency seams for computeLocalCarrierScope/computeLocalCarrierScopeAsync,
 * real implementations by default. Exists so tests can force each branch
 * (Linux success, Linux failure, macOS success/partial-failure/total-failure)
 * without mocking node:fs/node:os/node:child_process module-wide — which
 * would also affect every other real-filesystem test in this file's suite.
 *
 * The macOS fields are optional: a ScopeProbe built only for the Linux
 * branch (this file has many) remains valid without them, and readDarwinScope
 * below treats a missing field the same as a failing one -- both fall
 * through to undefined. There is deliberately no Windows field — see
 * computeLocalCarrierScopeAsync's docstring for why.
 */
export type ScopeProbe = {
    readBootId: () => string;
    readPidNamespaceId: () => string;
    hostname: () => string;
    readDarwinMachineId?: () => Promise<string>;
    readDarwinBootSessionId?: () => Promise<string>;
};

const defaultScopeProbe: ScopeProbe = {
    readBootId: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    readPidNamespaceId: () => {
        // Linux exposes the PID namespace as a magic symlink whose target
        // encodes its inode number, e.g. "pid:[4026531836]" — that number
        // is the namespace identifier.
        const link = readlinkSync('/proc/self/ns/pid');
        const match = /pid:\[(\d+)\]/.exec(link);
        if (!match) throw new Error(`unexpected /proc/self/ns/pid format: ${link}`);
        return match[1];
    },
    hostname: () => hostname(),
    readDarwinMachineId: readDarwinMachineIdReal,
    readDarwinBootSessionId: readDarwinBootSessionIdReal,
};

/**
 * Combines the two macOS identifiers into this platform's scope string.
 * Requires BOTH — a machine id without a boot id (or vice versa) is not a
 * stronger guarantee than nothing, since PID-space collision requires the
 * pair to distinguish "same machine, different boot" from "same machine,
 * same boot". A missing probe field is treated identically to a throwing
 * one: both fall through to undefined (preserve).
 */
async function readDarwinScope(probe: Pick<ScopeProbe, 'readDarwinMachineId' | 'readDarwinBootSessionId'>): Promise<string | undefined> {
    if (!probe.readDarwinMachineId || !probe.readDarwinBootSessionId) return undefined;
    try {
        const [machineId, bootSessionId] = await Promise.all([probe.readDarwinMachineId(), probe.readDarwinBootSessionId()]);
        if (!machineId || !bootSessionId) return undefined;
        return `darwin:${machineId}:${bootSessionId}`;
    } catch {
        return undefined;
    }
}

/**
 * Computes this process's carrier scope: an opaque string identifying
 * "carriers this process could plausibly own", used to gate sweepAgyHookCarriers.
 *
 * Synchronous and Linux-only. There is deliberately no hostname fallback:
 * hostname is not an identity. Two machines or containers that share a
 * HAPI_HOME and happen to share a hostname would compute the same scope, and
 * a pid that is live on the owning system reads as ESRCH here — deleting a
 * carrier out from under a running agy, which is spawned with
 * --dangerously-skip-permissions and depends on that carrier's hooks.json
 * for its PreToolUse approval bridge.
 *
 * Returning undefined makes sweepAgyHookCarriers preserve everything. On
 * this (sync, Linux-only) path that costs orphaned carriers on platforms
 * without a working /proc, which is the cheaper failure: normal teardown
 * still removes carriers via cleanupAgyHookCarrier, so only crash leftovers
 * accumulate. macOS identity is computed asynchronously instead (see
 * warmCarrierScope below) and is not reachable from this function — this one
 * stays the synchronous fallback writeOwnerMetadata uses when nothing has
 * warmed the cache yet. Windows has no supported identity at all — see
 * computeLocalCarrierScopeAsync's docstring.
 */
export function computeLocalCarrierScope(probe: ScopeProbe = defaultScopeProbe): string | undefined {
    return readLinuxBootAndNamespaceScope(probe);
}

/**
 * Async counterpart of computeLocalCarrierScope, dispatching on
 * process.platform to the strong-identity computation for that platform.
 * Any platform this module does not recognize (or a platform whose probe(s)
 * fail/time out) resolves to undefined, which — same as always — makes
 * sweepAgyHookCarriers preserve everything rather than fall back to a
 * weaker heuristic. Windows falls into this "unrecognized" bucket
 * deliberately — see below.
 *
 * Windows is deliberately not enabled here (evaluated and rejected
 * 2026-08-07, hostile-review round 1). `MachineGuid` (from the registry) is
 * the obvious candidate for a win32 scope, but it is wrong: `MachineGuid` is
 * a machine identifier, not a PID-space identifier — it is written once at
 * OS install time and is NOT regenerated by cloning a disk image (that is
 * exactly what `sysprep` exists to fix). Two clones of the same image that
 * share a HAPI_HOME (SMB share, sync folder, shared VM folder) compute the
 * IDENTICAL `win32:<guid>` scope while having completely independent PID
 * spaces — a
 * pid alive in one clone reads as ESRCH in the other, so sweep would delete
 * a live session's carrier and its --dangerously-skip-permissions approval
 * bridge with it. Linux (`boot_id`) and macOS (`kern.bootsessionuuid`) both
 * close this because those identifiers are regenerated every boot; Windows
 * has no cheap equivalent:
 *   - `HKLM\SYSTEM\CurrentControlSet\Control\Windows` has no boot-id key
 *     (only `ShutdownTime`, a REG_BINARY of the last *shutdown* — which a
 *     clone shares just as much as MachineGuid).
 *   - `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager` has nothing
 *     boot-scoped either.
 *   - `Win32_OperatingSystem.LastBootUpTime` via CIM was measured at
 *     1.4-2.5s per call on real hardware (2026-08-07) — this is meant to be
 *     cheap identity plumbing, not a multi-second startup cost.
 *   - `net statistics workstation` / `systeminfo` output is locale-dependent
 *     (parsing failed against Korean-locale Windows output in testing) —
 *     unfit as a machine-parsed identifier source regardless of cost.
 * So, unlike Linux/macOS, Windows cannot prove "same boot, same PID space"
 * at any price this module is willing to pay, and per this file's core
 * policy (identification failure -> preserve, no weak-identity fallback —
 * see computeLocalCarrierScope's docstring) it stays undefined rather than
 * risk the over-delete above. Before re-enabling Windows, find a boot-scoped
 * (not machine-scoped) identifier cheaper than CIM; re-measure whatever the
 * current Windows version offers rather than trusting this comment's
 * numbers to still hold.
 */
async function computeLocalCarrierScopeAsync(probe: ScopeProbe): Promise<string | undefined> {
    if (process.platform === 'linux') return readLinuxBootAndNamespaceScope(probe);
    if (process.platform === 'darwin') return readDarwinScope(probe);
    return undefined;
}

// Process-lifetime cache for the async scope computation. boot/machine
// identity is invariant for the life of this process, so computing it once
// and reusing the result is always correct — there is no staleness window
// to worry about (contrast with e.g. a TTL cache). `undefined` is a valid,
// deliberately-cached outcome (see warmCarrierScope's docstring): a failed
// probe is not retried on a later call, matching computeLocalCarrierScope's
// existing "no retry, just report the failure" contract.
let scopeCache: { value: string | undefined } | undefined;
// The in-flight computation, so a second warmCarrierScope() call issued
// before the first has settled awaits the SAME probe run instead of
// launching a duplicate one (relevant once the macOS probes spawn child
// processes — a duplicate run would double that cost for no benefit).
let scopeWarmupPromise: Promise<void> | undefined;

/**
 * Populates the module-level scope cache by running computeLocalCarrierScopeAsync
 * once and memoizing the result (success OR failure — both are cached, never
 * retried). Safe to call from a hot path without awaiting it (fire-and-forget):
 * it never throws or leaves an unhandled rejection.
 *
 * Callers: runAgy.ts fires this without awaiting it early in PTY session
 * setup (so the (eventually async, cross-process) probe cost overlaps with
 * hook-server startup instead of adding to it), then awaits it immediately
 * before prepareAgyHookCarrier() so writeOwnerMetadata (synchronous, see
 * below) reads a warm cache instead of falling back to the Linux-only sync
 * path. A respawn (agyPtyLauncher.ts's syncPreInvocationHookForLaunch) is
 * always in the same process, so its prepareAgyHookCarrier() call always
 * finds an already-warm cache with no extra wiring needed there.
 */
export function warmCarrierScope(probe: ScopeProbe = defaultScopeProbe): Promise<void> {
    if (!scopeWarmupPromise) {
        scopeWarmupPromise = computeLocalCarrierScopeAsync(probe)
            .then((value) => { scopeCache = { value }; })
            .catch(() => { scopeCache = { value: undefined }; });
    }
    return scopeWarmupPromise;
}

/**
 * Test-only reset for the module-level scope cache — vitest gives each test
 * FILE its own module registry (so this never leaks across files), but
 * multiple `it()`s within the same file share this module's state, and
 * several tests deliberately warm the cache with a fabricated probe result.
 * Not for production use.
 */
export function _resetCarrierScopeCacheForTests(): void {
    scopeCache = undefined;
    scopeWarmupPromise = undefined;
}

/**
 * Scope resolution used by sweepAgyHookCarriers. The DEFAULT probe (the real
 * one, used in production) goes through the warm cache — see warmCarrierScope.
 * Any OTHER probe object (identity-compared) bypasses the cache and computes
 * fresh on every call: a custom probe exists specifically so a test can force
 * a particular scenario for THAT call, and sharing the cache across differing
 * probes would let an earlier call's cached result leak into a later call
 * that intended a different, injected outcome (this file's test suites pass
 * many different custom probes to sweepAgyHookCarriers across many tests).
 */
async function resolveLocalCarrierScope(probe: ScopeProbe): Promise<string | undefined> {
    if (probe !== defaultScopeProbe) {
        return computeLocalCarrierScopeAsync(probe);
    }
    await warmCarrierScope(probe);
    return scopeCache?.value;
}

/**
 * Root directory HAPI creates all agy hook carriers under: `<HAPI_HOME>/
 * agy-carriers/`. Resolved fresh on every call (via resolveHapiHomeDir(),
 * not the cached `configuration.happyHomeDir` singleton) so an isolated E2E
 * stack that overrides HAPI_HOME per-process gets carriers that are
 * automatically isolated too, with no extra wiring.
 */
function agyCarriersRootDir(): string {
    return join(resolveHapiHomeDir(), AGY_CARRIERS_DIRNAME);
}

/**
 * Create an extra AGY workspace containing HAPI's session-local hook and MCP plugin.
 * The user's HOME, global hooks, and target project remain untouched.
 */
export function prepareAgyHookCarrier(
    hooksJsonContent: string,
    mcpServer?: AgyMcpServerEntry
): AgyHookCarrier | undefined {
    let carrierDir: string | undefined;
    try {
        const carriersRoot = agyCarriersRootDir();
        mkdirSync(carriersRoot, { recursive: true, mode: 0o700 });
        carrierDir = mkdtempSync(join(carriersRoot, CARRIER_DIR_PREFIX));
        writeOwnerMetadata(carrierDir);
        const agentsDir = join(carrierDir, '.agents');
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(agentsDir, 'hooks.json'), hooksJsonContent, { mode: 0o600 });
        if (mcpServer) {
            const pluginDir = join(agentsDir, 'plugins', 'hapi');
            mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
            writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'hapi' }), { mode: 0o600 });
            writeFileSync(
                join(pluginDir, 'mcp_config.json'),
                JSON.stringify({ mcpServers: { hapi: mcpServer } }),
                { mode: 0o600 }
            );
        }
        logger.debug(`[agyHookCarrier] prepared at ${carrierDir}`);
        return { carrierDir };
    } catch (error) {
        if (carrierDir) {
            try { rmSync(carrierDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        logger.debug('[agyHookCarrier] preparation failed', error);
        return undefined;
    }
}

/**
 * Records which process owns a carrier, at the carrier root — deliberately
 * outside .agents/, which is the directory agy itself reads (hooks.json,
 * plugins/); owner metadata is HAPI-only bookkeeping and must never show up
 * there.
 */
function writeOwnerMetadata(carrierDir: string): void {
    // A carrier written while the local scope could not be determined
    // records no scope at all rather than a fabricated one — readOwnerMetadata
    // requires a non-empty scope, so this carrier falls into the
    // "unreadable owner" bucket below and is preserved indefinitely rather
    // than risk being matched against a wrong or guessed scope later.
    //
    // This function is synchronous (prepareAgyHookCarrier's respawn-time
    // caller, agyPtyLauncher.ts's syncPreInvocationHookForLaunch, must stay
    // synchronous — see that function's fail-closed-contract docstring), so
    // it cannot await an async probe. It reads the warm cache (populated by
    // warmCarrierScope — see runAgy.ts, which awaits it before the FIRST
    // prepareAgyHookCarrier() call of a session) if one is available, and
    // otherwise falls back to the synchronous Linux-only computation — the
    // same computation this function used before the cache existed. A cache
    // miss on macOS (warmCarrierScope not yet awaited anywhere in this
    // process) or an unsupported platform (Windows — see
    // computeLocalCarrierScopeAsync's docstring) therefore still yields
    // undefined/empty scope, same as always: this fallback trades nothing
    // away, it only adds a faster path when a cache is available.
    //
    // hostile-review round 1 finding ②: this correctness depends on
    // warmCarrierScope() having actually been awaited by the caller before
    // this runs (runAgy.ts does; see its "await warmCarrierScope()" call
    // right before prepareAgyHookCarrier()) -- nothing in this function's
    // own signature enforces that ordering. The debug log below is the
    // fallback signal for when it silently doesn't hold (a future call site
    // that skips the await, a refactor that reorders it): an empty scope
    // written here permanently preserves this carrier (see the sweep
    // docstring), so at minimum that should be visible in the debug log
    // instead of vanishing without a trace.
    const scope = scopeCache !== undefined ? scopeCache.value : computeLocalCarrierScope();
    // hostile-review round 2 finding ③: gated to linux/darwin, where an
    // empty scope is always an anomaly worth a trace (a genuine probe
    // failure, or the ordering bug this log exists to catch). On win32 an
    // empty scope is the permanent, documented baseline (see
    // computeLocalCarrierScopeAsync's docstring) -- logging it there would
    // fire on every single carrier creation and drown out the actual
    // anomaly this is meant to surface on the platforms where it matters.
    if (!scope && (process.platform === 'linux' || process.platform === 'darwin')) {
        logger.debug(`[agyHookCarrier] writing owner metadata with no local scope for ${carrierDir} — this carrier will be preserved indefinitely by sweepAgyHookCarriers`);
    }
    const owner: AgyHookCarrierOwner = { pid: process.pid, scope: scope ?? '' };
    writeFileSync(join(carrierDir, OWNER_FILE_NAME), JSON.stringify(owner), { mode: 0o600 });
}

async function readOwnerMetadata(carrierDir: string): Promise<AgyHookCarrierOwner | undefined> {
    try {
        const parsed = JSON.parse(await readFile(join(carrierDir, OWNER_FILE_NAME), 'utf8')) as Partial<AgyHookCarrierOwner>;
        if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 && typeof parsed.scope === 'string' && parsed.scope.length > 0) {
            return { pid: parsed.pid, scope: parsed.scope };
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Distinguishes "definitely dead" from "definitely alive" from "can't tell"
 * for a PID, using process.kill(pid, 0) (sends no signal, just probes).
 *
 * This deliberately does NOT reuse @/utils/process's isProcessAlive(): that
 * helper treats every kill() failure — ESRCH (no such process) AND EPERM
 * (process exists, we just don't own it) — as "not alive", which is correct
 * for its callers but wrong here. A carrier owned by a live process we don't
 * have permission to signal is exactly the case sweeping must NOT delete
 * (see the agy-preinvocation-discovery plan §8) — collapsing it into "dead"
 * would make the sweep as unsafe as the mtime/name heuristics it replaces.
 */
function checkProcessLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
    try {
        process.kill(pid, 0);
        return 'alive';
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ESRCH') return 'dead';
        if (code === 'EPERM') return 'alive';
        // Anything else (unexpected errno, platform quirk) is unknown, not
        // dead — preservation is the safe default when liveness can't be
        // determined with confidence.
        return 'unknown';
    }
}

/**
 * Removes agy hook carriers under HAPI_HOME whose owning process has been
 * ACTIVELY confirmed dead: owner.json is present and parses (pid + a
 * non-empty scope), that scope exactly matches this process's own
 * computeLocalCarrierScope(), AND process.kill(pid, 0) raises ESRCH for that
 * pid. Meant to be called once per session start — see runAgy.ts.
 *
 * Fix 2 (hardened from the original hostname-only Fix N6): two things used
 * to let this delete a carrier that was still very much in use.
 *
 *  (a) A carrier whose owner.json failed to read — for ANY reason, not just
 *      "genuinely never written" — used to be swept once it turned 24h old.
 *      But a transient read failure (a concurrent write racing the read, a
 *      momentarily-unmounted overlay, ...) against a live, multi-day agy
 *      session looks IDENTICAL to a genuinely ownerless leftover from this
 *      function's point of view — there is no way to tell them apart from
 *      here. Sweeping on age alone in that case can delete a carrier a
 *      running session still depends on for its permission bridge. There is
 *      no longer an age-based path at all: an unreadable/missing owner.json
 *      is now preserved unconditionally. The cost is that legacy
 *      (pre-this-fix) or truly-orphaned ownerless carriers never get swept
 *      automatically — every carrier created after this fix always has a
 *      readable owner.json, so this cost is one-time, not ongoing.
 *
 *  (b) hostname alone doesn't identify a PID namespace: two containers
 *      sharing a HAPI_HOME (bind mount, NFS home) commonly also share a
 *      hostname, so a pid recorded by one could be misread as belonging to
 *      the other's PID space and probed there. computeLocalCarrierScope's
 *      boot-id+PID-namespace scope (falling back to a distinctly-tagged
 *      hostname only where /proc isn't usable) closes this the same way a
 *      stronger identity always beats a weaker one: an exact match is
 *      required, not merely a matching hostname.
 *
 * Deliberately conservative in every ambiguous direction, in this priority
 * order: local scope cannot be determined at all -> preserve everything
 * (never scan for anything to delete); a carrier's owner cannot be read ->
 * preserve; a carrier's owner scope doesn't exactly match -> preserve; the
 * owner is alive (including EPERM — alive, just not ours) or liveness can't
 * be determined -> preserve. Only "read owner, scope matches, pid confirmed
 * dead" deletes. Over-deleting a carrier still in use silently kills that
 * session's permission bridge and discovery hook; over-preserving a truly
 * dead carrier just leaves inert bytes on disk under HAPI_HOME. The two
 * mistakes are not symmetric, so this only ever errs toward preservation.
 *
 * Best-effort and side-effect-free on failure: an unreadable carriers root,
 * or a single entry this process can't stat/read, is skipped rather than
 * thrown — a broken sweep must never abort session startup.
 */
export async function sweepAgyHookCarriers(scopeProbe: ScopeProbe = defaultScopeProbe): Promise<void> {
    const carriersRoot = agyCarriersRootDir();
    let entries: string[];
    // Snapshotting the directory listing BEFORE resolving the local scope is
    // load-bearing, not incidental ordering — swap these two lines and the
    // "racing safety" guarantee (agyHookCarrier.test.ts) silently weakens.
    // resolveLocalCarrierScope() can take real wall-clock time on macOS (two
    // child processes, ~50ms combined per the Phase 2-B cost measurement),
    // during which a concurrent prepareAgyHookCarrier() in this same process
    // (see runAgy.ts, which now fires sweep without awaiting it) can mkdtemp
    // a brand-new carrier. Taking the readdir() snapshot first means that
    // carrier is simply never in the list this loop iterates below,
    // regardless of how long the scope probe takes afterward. Reversing the
    // order would instead let the scope probe's latency open a window where
    // a carrier created during it IS included in a still-to-be-taken
    // snapshot -- collapsing the margin the "created after the snapshot"
    // test exists to prove.
    try {
        entries = await readdir(carriersRoot);
    } catch {
        // Root doesn't exist yet (first-ever session under this HAPI_HOME)
        // or isn't readable — nothing to sweep either way.
        return;
    }

    const localScope = await resolveLocalCarrierScope(scopeProbe);
    if (!localScope) {
        // Cannot identify which carriers this process could even plausibly
        // own — comparing anything against an unknown scope is meaningless,
        // so nothing is examined at all rather than falling back to a
        // weaker (and potentially wrong) heuristic.
        logger.debug('[agyHookCarrier] sweep skipped entirely: could not determine local carrier scope');
        return;
    }

    // Sequential, not Promise.all: this is a backup path with no latency
    // requirement (see the module docstring), and processing one entry at a
    // time keeps each entry's error handling isolated without adding
    // concurrency-ordering complexity to a destructive operation.
    for (const entry of entries) {
        // Fix N3: only ever consider entries this module itself could have
        // created. A misconfigured/reused HAPI_HOME can put anything under
        // agy-carriers/ (another app's state dir, a stray checkout, ...) —
        // without this check, a bad match below could recursive-delete it.
        if (!entry.startsWith(CARRIER_DIR_PREFIX)) continue;
        const carrierDir = join(carriersRoot, entry);
        try {
            // Fix N4: lstat, not stat — judge the directory entry itself,
            // never whatever a symlink might point at. rm only ever unlinks
            // a symlink (never recurses through it), so there is no
            // data-loss path either way, but liveness/scope decisions must
            // still be about this entry, not its target.
            const stats = await lstat(carrierDir);
            if (!stats.isDirectory()) continue;

            const owner = await readOwnerMetadata(carrierDir);
            if (!owner) {
                // Fix 2a: no age-based fallback anymore — see the docstring
                // above for why an unreadable owner is no longer evidence of
                // staleness. This also covers a carrier whose directory this
                // readdir() snapshot caught mid-creation (mkdtemp landed,
                // owner.json has not been written yet by a concurrent
                // prepareAgyHookCarrier — see this function's own docstring
                // on why sweeping is no longer on the session-boot critical
                // path and can race a fresh carrier's creation): an
                // unreadable owner is preserved unconditionally, the same as
                // a genuinely-never-written one.
                continue;
            }
            if (owner.scope !== localScope) {
                // Fix 2b: a pid recorded under a different boot/PID-namespace
                // means nothing in this process's PID space — never probe
                // it, never delete it.
                continue;
            }
            if (checkProcessLiveness(owner.pid) === 'dead') {
                await rm(carrierDir, { recursive: true, force: true });
                logger.debug(`[agyHookCarrier] swept orphaned carrier ${carrierDir} (owner pid ${owner.pid}, scope matched, confirmed dead)`);
            }
        } catch (error) {
            logger.debug(`[agyHookCarrier] sweep skipped ${carrierDir}`, error);
        }
    }
}

/**
 * True if the carrier's hooks.json is present and therefore safe to
 * overwrite in place. False covers both "the whole carrier directory is
 * gone" (e.g. /tmp's 30-day tmpfiles.d sweep on a long-lived session, see
 * the agy-preinvocation-discovery plan §9) and "hooks.json specifically was
 * removed" — either way, the caller must rebuild the carrier from scratch
 * (prepareAgyHookCarrier) rather than attempt an atomic overwrite, since
 * writeAgyHooksJsonAtomic requires the .agents directory to already exist.
 */
export function agyHookCarrierIsIntact(carrierDir: string): boolean {
    return existsSync(join(carrierDir, '.agents', 'hooks.json'));
}

/**
 * Overwrite an existing carrier's hooks.json in place, atomically.
 *
 * agy re-reads hooks.json before every single model call (confirmed live —
 * see the agy-preinvocation-discovery plan §6.6), not just once at spawn
 * time. That means a plain writeFileSync has a real window where agy can
 * observe a partially-written file: JSON.parse throws, agy drops every hook
 * registered under this carrier for that read (including the PreToolUse
 * permission bridge, not just the PreInvocation discovery hook this function
 * is used to add/remove). Writing to a sibling temp file in the same
 * directory and renaming over the target avoids that window — rename() is
 * atomic on the same filesystem, so agy only ever observes the old complete
 * file or the new complete file, never a partial one.
 *
 * Throws if the carrier's .agents directory does not exist; callers must
 * check agyHookCarrierIsIntact() first and fall back to
 * prepareAgyHookCarrier() (a fresh carrier) if it does not.
 *
 * Fix N5: the temp file must be a same-directory sibling of the target for
 * renameSync's atomicity to hold (see above) — it cannot simply be moved
 * outside .agents/ to satisfy writeOwnerMetadata's "no HAPI bookkeeping
 * inside .agents/" rule (that rule is about files agy's own directory scan
 * could stumble on; a same-fs rename target is a different constraint
 * entirely). So instead, a failed renameSync (or a throw from the caller's
 * own error handling further up the stack — this function is best-effort
 * per detachPreInvocationHook/syncPreInvocationHookForLaunch's fail-open
 * contract) must not leave the temp file behind: without cleanup, every
 * failed detach/re-attach cycle leaves one more `.hooks.json.<pid>.<uuid>.tmp`
 * sitting in .agents/ forever.
 */
export function writeAgyHooksJsonAtomic(carrierDir: string, hooksJsonContent: string): void {
    const agentsDir = join(carrierDir, '.agents');
    const target = join(agentsDir, 'hooks.json');
    const tmpPath = join(agentsDir, `.hooks.json.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
        writeFileSync(tmpPath, hooksJsonContent, { mode: 0o600 });
        renameSync(tmpPath, target);
        renamed = true;
    } finally {
        // renameSync already moved the file away on success — unlink would
        // just throw ENOENT for no reason, so only clean up on the failure
        // path (finally still runs there too; the original error propagates
        // after this block regardless). This also covers writeFileSync itself
        // throwing (ENOSPC, EDQUOT, ...) before the file was fully written —
        // without the write inside this try, a failed write would leave a
        // partial temp file behind with nothing to clean it up.
        if (!renamed) {
            try { unlinkSync(tmpPath); } catch { /* best-effort */ }
        }
    }
}

export function cleanupAgyHookCarrier(carrierDir: string | undefined): void {
    if (!carrierDir) return;
    try {
        rmSync(carrierDir, { recursive: true, force: true });
        logger.debug(`[agyHookCarrier] cleaned up ${carrierDir}`);
    } catch (error) {
        logger.debug(`[agyHookCarrier] cleanup failed for ${carrierDir}`, error);
    }
}
