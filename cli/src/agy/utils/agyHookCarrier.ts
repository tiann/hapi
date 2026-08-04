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
// PID-namespace pair a carrier's pid was recorded in — see
// computeLocalCarrierScope() below — which distinguishes exactly the cases
// hostname could not: two containers on the same host (different PID
// namespaces, same boot_id) and the same container across a restart
// (same PID namespace file, but the boot_id — read from the host's
// /proc — differs only across an actual host reboot, which is the one case
// where every previously-recorded pid is unconditionally dead; this fix
// does not attempt to special-case that, see sweepAgyHookCarriers's
// docstring). Platforms without a working /proc (macOS, ...) get no scope at
// all and are therefore never swept — hostname is not an identity, so there
// is deliberately no fallback (see computeLocalCarrierScope).
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

/**
 * Dependency seams for computeLocalCarrierScope, real implementations by
 * default. Exists so tests can force each branch (Linux success, Linux
 * failure -> hostname fallback, total failure) without mocking node:fs/
 * node:os module-wide — which would also affect every other real-filesystem
 * test in this file's suite.
 */
export type ScopeProbe = {
    readBootId: () => string;
    readPidNamespaceId: () => string;
    hostname: () => string;
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
};

/**
 * Computes this process's carrier scope: an opaque string identifying
 * "carriers this process could plausibly own", used to gate sweepAgyHookCarriers.
 *
 * Only the Linux boot-id+PID-namespace pair qualifies. There is deliberately
 * no hostname fallback: hostname is not an identity. Two machines or
 * containers that share a HAPI_HOME and happen to share a hostname would
 * compute the same scope, and a pid that is live on the owning system reads
 * as ESRCH here — deleting a carrier out from under a running agy, which is
 * spawned with --dangerously-skip-permissions and depends on that carrier's
 * hooks.json for its PreToolUse approval bridge.
 *
 * Returning undefined makes sweepAgyHookCarriers preserve everything. That
 * costs orphaned carriers on platforms without a strong identity (macOS, a
 * restricted /proc), which is the cheaper failure: normal teardown still
 * removes carriers via cleanupAgyHookCarrier, so only crash leftovers
 * accumulate. Add a platform-specific boot/namespace identity here before
 * re-enabling sweeping there.
 */
export function computeLocalCarrierScope(probe: ScopeProbe = defaultScopeProbe): string | undefined {
    return readLinuxBootAndNamespaceScope(probe);
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
    const scope = computeLocalCarrierScope();
    const owner: AgyHookCarrierOwner = { pid: process.pid, scope: scope ?? '' };
    writeFileSync(join(carrierDir, OWNER_FILE_NAME), JSON.stringify(owner), { mode: 0o600 });
}

function readOwnerMetadata(carrierDir: string): AgyHookCarrierOwner | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(carrierDir, OWNER_FILE_NAME), 'utf8')) as Partial<AgyHookCarrierOwner>;
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
export function sweepAgyHookCarriers(scopeProbe: ScopeProbe = defaultScopeProbe): void {
    const carriersRoot = agyCarriersRootDir();
    let entries: string[];
    try {
        entries = readdirSync(carriersRoot);
    } catch {
        // Root doesn't exist yet (first-ever session under this HAPI_HOME)
        // or isn't readable — nothing to sweep either way.
        return;
    }

    const localScope = computeLocalCarrierScope(scopeProbe);
    if (!localScope) {
        // Cannot identify which carriers this process could even plausibly
        // own — comparing anything against an unknown scope is meaningless,
        // so nothing is examined at all rather than falling back to a
        // weaker (and potentially wrong) heuristic.
        logger.debug('[agyHookCarrier] sweep skipped entirely: could not determine local carrier scope');
        return;
    }

    for (const entry of entries) {
        // Fix N3: only ever consider entries this module itself could have
        // created. A misconfigured/reused HAPI_HOME can put anything under
        // agy-carriers/ (another app's state dir, a stray checkout, ...) —
        // without this check, a bad match below could recursive-delete it.
        if (!entry.startsWith(CARRIER_DIR_PREFIX)) continue;
        const carrierDir = join(carriersRoot, entry);
        try {
            // Fix N4: lstat, not stat — judge the directory entry itself,
            // never whatever a symlink might point at. rmSync only ever
            // unlinks a symlink (never recurses through it), so there is no
            // data-loss path either way, but liveness/scope decisions must
            // still be about this entry, not its target.
            const stats = lstatSync(carrierDir);
            if (!stats.isDirectory()) continue;

            const owner = readOwnerMetadata(carrierDir);
            if (!owner) {
                // Fix 2a: no age-based fallback anymore — see the docstring
                // above for why an unreadable owner is no longer evidence of
                // staleness.
                continue;
            }
            if (owner.scope !== localScope) {
                // Fix 2b: a pid recorded under a different boot/PID-namespace
                // means nothing in this process's PID space — never probe
                // it, never delete it.
                continue;
            }
            if (checkProcessLiveness(owner.pid) === 'dead') {
                rmSync(carrierDir, { recursive: true, force: true });
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
