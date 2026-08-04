import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs';
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

// hostname is the over-delete guard for a shared HAPI_HOME (Fix N6): a
// devcontainer bind-mounting ~/.hapi, or an NFS-shared home, puts carriers
// written by different PID namespaces in the same agy-carriers/ directory.
// A pid recorded by namespace A means nothing in namespace B — probing it
// there can hit ESRCH for a process that is very much alive in A. hostname
// does not fully solve cross-host PID collisions (two hosts using the same
// hostname, or two containers sharing a hostname, remain unresolved — no
// occurrence of this so far, and not what this fix targets), but it closes
// the concrete case the reviewer raised. Sweep only ever probes liveness
// for a carrier this host itself could plausibly own.
type AgyHookCarrierOwner = {
    pid: number;
    hostname: string;
};

const AGY_CARRIERS_DIRNAME = 'agy-carriers';
const OWNER_FILE_NAME = 'owner.json';
// Every carrier prepareAgyHookCarrier() creates is mkdtemp'd under this
// prefix (see below). Sweep must never touch a directory that doesn't carry
// it — HAPI_HOME misconfiguration or reuse (pointing an unrelated HAPI_HOME
// at a directory with other content) must never turn into a recursive
// delete of whatever else happens to live there (Fix N3).
const CARRIER_DIR_PREFIX = 'hapi-agy-carrier-';

// Carriers whose owner.json is missing or unreadable (pre-Phase-2.8 builds,
// or a write that got interrupted) are legacy/ambiguous, not confirmed dead.
// Give them a full day before sweeping them on age alone — long enough that
// a carrier still mid-creation or briefly unreadable is never caught by it,
// short enough that real leftovers don't linger for the OS's own 30-day
// tmpfiles.d window (see the agy-preinvocation-discovery plan §8/§9).
const STALE_OWNERLESS_CARRIER_AGE_MS = 24 * 60 * 60 * 1000;

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
    const owner: AgyHookCarrierOwner = { pid: process.pid, hostname: hostname() };
    writeFileSync(join(carrierDir, OWNER_FILE_NAME), JSON.stringify(owner), { mode: 0o600 });
}

function readOwnerMetadata(carrierDir: string): AgyHookCarrierOwner | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(carrierDir, OWNER_FILE_NAME), 'utf8')) as Partial<AgyHookCarrierOwner>;
        if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 && typeof parsed.hostname === 'string' && parsed.hostname.length > 0) {
            return { pid: parsed.pid, hostname: parsed.hostname };
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
 * Removes agy hook carriers under HAPI_HOME whose owning process has
 * confirmed-died (process.kill(pid, 0) raises ESRCH), and carriers old
 * enough with unreadable/missing owner metadata to be considered stale
 * leftovers. Meant to be called once per session start — see runAgy.ts.
 *
 * Deliberately conservative in every ambiguous direction: a carrier whose
 * owner is alive (including EPERM — alive, just not ours), whose owner is
 * on a different host (Fix N6 — a shared HAPI_HOME, e.g. a devcontainer
 * bind-mounting ~/.hapi or an NFS home, means a pid recorded by another
 * host's PID namespace is meaningless here and must never be probed), or
 * whose liveness can't be determined is preserved, never removed.
 * Over-deleting a carrier still in use silently kills that session's
 * permission bridge and discovery hook; over-preserving a truly dead
 * carrier just leaves inert bytes on disk. The two mistakes are not
 * symmetric, so this only ever errs toward preservation.
 *
 * Best-effort and side-effect-free on failure: an unreadable carriers root,
 * or a single entry this process can't stat/read, is skipped rather than
 * thrown — a broken sweep must never abort session startup.
 */
export function sweepAgyHookCarriers(): void {
    const carriersRoot = agyCarriersRootDir();
    let entries: string[];
    try {
        entries = readdirSync(carriersRoot);
    } catch {
        // Root doesn't exist yet (first-ever session under this HAPI_HOME)
        // or isn't readable — nothing to sweep either way.
        return;
    }

    for (const entry of entries) {
        // Fix N3: only ever consider entries this module itself could have
        // created. A misconfigured/reused HAPI_HOME can put anything under
        // agy-carriers/ (another app's state dir, a stray checkout, ...) —
        // without this check, the age-based owner-less fallback below would
        // happily recursive-delete it once it turned 24h old.
        if (!entry.startsWith(CARRIER_DIR_PREFIX)) continue;
        const carrierDir = join(carriersRoot, entry);
        try {
            // Fix N4: lstat, not stat — judge the directory entry itself,
            // never whatever a symlink might point at. rmSync only ever
            // unlinks a symlink (never recurses through it), so there is no
            // data-loss path either way, but liveness/age decisions must
            // still be about this entry, not its target.
            const stats = lstatSync(carrierDir);
            if (!stats.isDirectory()) continue;

            const owner = readOwnerMetadata(carrierDir);
            if (owner) {
                if (owner.hostname !== hostname()) {
                    // Fix N6: a pid recorded on another host means nothing
                    // in this PID namespace — never probe it, never delete.
                    //
                    // Known trade-off (R5-3, won't-fix): if the hostname
                    // itself changes underneath a carrier (DHCP-assigned
                    // name, container restart, VPN interface renaming...),
                    // this guard permanently mismatches and the carrier is
                    // never swept — owner.json is present and readable, so
                    // the age-based owner-less fallback below never triggers
                    // either. This is deliberately left as-is: erring toward
                    // over-retention is the safe direction (the alternative
                    // is deleting a live carrier out from under a process
                    // that renamed its host), the affected population is
                    // narrow (only sessions that crashed — a clean exit is
                    // swept by cleanupAgyHookCarrier regardless of hostname
                    // — *and* whose host was then renamed before the process
                    // died of natural causes), and what's left behind is a
                    // few inert bytes under HAPI_HOME, not a leak with
                    // externally visible effects. Do not add a time-based
                    // fallback for this case without revisiting why the
                    // pid-liveness check above was deemed unsafe to trust
                    // across a hostname change in the first place.
                    continue;
                }
                if (checkProcessLiveness(owner.pid) === 'dead') {
                    rmSync(carrierDir, { recursive: true, force: true });
                    logger.debug(`[agyHookCarrier] swept orphaned carrier ${carrierDir} (owner pid ${owner.pid} is dead)`);
                }
                continue;
            }

            if (Date.now() - stats.mtimeMs > STALE_OWNERLESS_CARRIER_AGE_MS) {
                rmSync(carrierDir, { recursive: true, force: true });
                logger.debug(`[agyHookCarrier] swept carrier with unreadable/missing owner metadata ${carrierDir} (older than ${STALE_OWNERLESS_CARRIER_AGE_MS}ms)`);
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
