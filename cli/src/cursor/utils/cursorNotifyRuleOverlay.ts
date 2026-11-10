/**
 * Per-session, workspace-local Cursor rule overlay for session status summaries.
 *
 * Cursor ACP has no HAPI-controlled system-prompt channel (unlike Claude / Codex /
 * OpenCode / Grok). It discovers rules from workspace `.cursor/rules/*.mdc`
 * files (plain `.md` is ignored) and global `~/.cursor` user rules. Editing the
 * global user rules would pollute the operator's non-HAPI Cursor experience, so
 * we install a transient, repo-local rule for the lifetime of a session and
 * remove it on teardown — only when the emit status-summary setting is on.
 *
 * Concurrent sessions sharing a cwd share ownership state under HAPI_HOME (not
 * inside the workspace) with live PIDs so: (1) only the last live owner restores
 * the pre-HAPI file, (2) crashed owners are reaped on the next install, and
 * (3) `git add -A` cannot stage bookkeeping sidecars.
 *
 * Non-clobbering discipline (mirrors how a config overlay behaves): if the user
 * already has a file at the same path we back up its contents and restore them on
 * cleanup; a file that already carries our sentinel is one of ours (a prior or
 * concurrent session in the same cwd), so we never treat it as user content —
 * UNLESS git tracks that path (then we fall through to an alternate filename).
 * All fs work is fail-open — a missing rule must never crash a session.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmdirSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SESSION_SUMMARY_CONTRACT_LINE } from '@/modules/common/sessionSummaryInstruction';
import { logger } from '@/ui/logger';
import { isProcessAlive } from '@/utils/process';

/** Preferred rule filename; fall back when Git already tracks this path. */
export const RULE_FILENAME_PRIMARY = 'hapi-session.mdc';
/** Alternate when the primary path is git-tracked (still alwaysApply). */
export const RULE_FILENAME_ALTERNATE = 'hapi-session-summary.mdc';
const RULE_CANDIDATES = [RULE_FILENAME_PRIMARY, RULE_FILENAME_ALTERNATE] as const;
const OWNERSHIP_LOCK_TIMEOUT_MS = 5_000;

/** Prefix for `.git/info/exclude` lease markers (do not commit transient rule). */
export const HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX = '# hapi-cursor-notify-rule';

/**
 * Hidden marker identifying files this overlay owns. Lets us distinguish a
 * user's pre-existing rule (back up + restore) from one written by another HAPI
 * session sharing the cwd.
 */
export const HAPI_SESSION_RULE_SENTINEL = '<!-- hapi:session-summary-rule -->';

export interface CursorNotifyRuleOverlay {
    /** Absolute path of the rule file this overlay manages. */
    readonly rulePath: string;
    /** Restore any pre-existing user file / remove ours, prune dirs we created. */
    cleanup: () => void;
}

export interface InstallCursorNotifyRuleOverlayOptions {
    /** Workspace root cursor-agent is spawned in (session.path). */
    cwd: string;
    /** Optional project name to bake into the example line. */
    project?: string | null;
    /** Optional agent id to bake into the example line. */
    agentId?: string | null;
}

type OverlayOwner = {
    /** Unique per install (same PID can own multiple overlays in tests / nested launches). */
    id: string;
    pid: number;
};

type OverlayOwnershipState = {
    cwd: string;
    owners: OverlayOwner[];
    /**
     * True once we have snapshotted the pre-HAPI rule state for this cwd.
     * Distinguishes "never captured" from "captured as absent" (`restore: null`).
     */
    snapshotTaken: boolean;
    /** Pre-HAPI rule bytes when `snapshotTaken`; null means no file existed. */
    restore: string | null;
};

type RuleTarget = {
    ruleFilename: string;
    /** Repo-relative path using `/` separators (git exclude / ls-files). */
    ruleRelPosix: string;
    rulePath: string;
};

/**
 * Build the `.mdc` rule content. `alwaysApply: true` so cursor-agent applies it
 * to every turn without the agent having to opt in. Kept deliberately benign and
 * functional: it reads as ordinary session-tracking config, not surveillance.
 *
 * Contract and #2267 post-done silence match `buildSessionSummaryInstruction`.
 */
export function buildNotifyRuleContent(opts: { project?: string | null; agentId?: string | null } = {}): string {
    const project = sanitizeToken(opts.project) ?? '<project>';
    const agentId = sanitizeToken(opts.agentId) ?? '<agent-id>';
    const exampleLine = SESSION_SUMMARY_CONTRACT_LINE
        .replace('"agent":"<agent-id>"', `"agent":"${agentId}"`)
        .replace('"project":"<project>"', `"project":"${project}"`);
    const exampleNoAction = `AGENT_NOTIFY_SUMMARY {"version":1,"agent":"${agentId}","project":"${project}","status":"done","summary":"one-line triage"}`;

    return [
        '---',
        'alwaysApply: true',
        '---',
        HAPI_SESSION_RULE_SENTINEL,
        '',
        '# Session status summary',
        '',
        'At the end of each turn, append exactly one machine-readable status line',
        '(no backticks) to the final answer only, so this workspace\'s session tracking',
        'can record progress. Do not emit this line in commentary, progress updates, or before tool calls.',
        'Put it on its own final line after all other content:',
        '',
        exampleLine,
        '',
        'When nothing remains, omit the action key entirely (example):',
        exampleNoAction,
        '',
        'Guidance:',
        '- Use the language used by the user in the current conversation for the',
        '  human-readable "action" and "summary" values.',
        '- status: pick the closest value; use "blocked" if unsure.',
        '- action: only when status is "done" and follow-up remains; 12 words or fewer.',
        '  Omit the action key when nothing remains. Never emit "action":"" —',
        '  Cursor drops a quote and breaks JSON.',
        '- summary: one-line triage of the turn outcome.',
        '- Keep it as the very last line of every response.',
        // Cross-turn close (#2267): status "done" ends the spoken unit.
        'After status "done", do not emit further user-visible replies for redundant',
        'background task-complete notifications until the user sends new intent.',
        ''
    ].join('\n');
}

/**
 * Install the rule file under `<cwd>/.cursor/rules/`, backing up any
 * pre-existing user file. Returns an overlay handle whose `cleanup()` restores
 * the prior state. Never throws: on failure it returns a no-op cleanup so callers
 * can wire it unconditionally.
 */
export function installCursorNotifyRuleOverlay(
    opts: InstallCursorNotifyRuleOverlayOptions
): CursorNotifyRuleOverlay {
    const absCwd = canonicalizeExistingPath(resolve(opts.cwd));
    const cursorDir = join(absCwd, '.cursor');
    const rulesDir = join(cursorDir, 'rules');
    const target = resolveRuleTarget(absCwd);
    const rulePath = target?.rulePath ?? join(rulesDir, RULE_FILENAME_PRIMARY);
    const ruleRelPosix = target?.ruleRelPosix ?? `.cursor/rules/${RULE_FILENAME_PRIMARY}`;
    // Ownership / lock / restore snapshot are scoped to the selected rule path
    // so primary vs alternate installs never share a restore target.
    const stateDir = getOverlayStateDir(absCwd, ruleRelPosix);
    const statePath = join(stateDir, 'state.json');
    // Lock lives beside stateDir so last-owner cleanup can clear state.json
    // while holding the lock without recursively deleting the lock's parent.
    const lockPath = `${stateDir}.lock`;
    const ownerId = randomUUID();
    const pid = process.pid;
    const excludeLeaseId = `${pid}:${ownerId}`;

    // Dirs we create so cleanup can prune exactly what we added (deepest first).
    const createdDirs: string[] = [];
    let cleaned = false;
    /** Owner row written to HAPI_HOME state (even if the workspace rule write fails). */
    let registered = false;
    /** Workspace rule successfully overwritten with generated content. */
    let installed = false;
    let undoGitExclude: (() => void) | null = null;

    if (!target) {
        logger.debug('[cursor-notify-rule] skip install — all candidate rule paths are git-tracked');
        return {
            rulePath,
            cleanup: () => {
                if (cleaned) return;
                cleaned = true;
            }
        };
    }

    try {
        assertNotSymlinkPath(cursorDir, 'Cursor config directory');
        assertNotSymlinkPath(rulesDir, 'Cursor rules directory');
        assertNotSymlinkPath(rulePath, 'Cursor session rule');

        if (!existsSync(cursorDir)) {
            mkdirSync(cursorDir, { recursive: true });
            createdDirs.push(cursorDir);
        }
        if (!existsSync(rulesDir)) {
            mkdirSync(rulesDir, { recursive: true });
            createdDirs.push(rulesDir);
        }
        // Re-check after mkdir: a race could replace a created dir with a symlink.
        assertNotSymlinkPath(cursorDir, 'Cursor config directory');
        assertNotSymlinkPath(rulesDir, 'Cursor rules directory');

        if (!existsSync(stateDir)) {
            mkdirSync(stateDir, { recursive: true });
        }

        withOwnershipLock(lockPath, () => {
            let state = reapOwners(readOwnershipState(statePath, absCwd));
            const current = existsSync(rulePath) ? safeRead(rulePath) : null;
            const stillOurs = current !== null && current.includes(HAPI_SESSION_RULE_SENTINEL);

            // Always refresh when the on-disk file is non-HAPI user content —
            // including while another session is still live — so a mid-session
            // operator replacement is what last-owner cleanup restores.
            if (current !== null && !stillOurs) {
                state = {
                    cwd: absCwd,
                    owners: state.owners,
                    snapshotTaken: true,
                    restore: current
                };
            } else if (state.owners.length === 0 && !state.snapshotTaken) {
                // First install (or recovered empty state): capture pre-HAPI bytes,
                // including an explicit "file was absent" snapshot.
                state = {
                    cwd: absCwd,
                    owners: [],
                    snapshotTaken: true,
                    restore: current
                };
            } else if (state.owners.length === 0) {
                // Crash recovery with our generated rule still present: keep the
                // prior snapshot (including restore:null).
                state = { ...state, owners: [] };
            }

            state.owners.push({ id: ownerId, pid });
            writeOwnershipState(statePath, state);
            registered = true;
        });

        undoGitExclude = installGitExcludeLease(absCwd, rulePath, excludeLeaseId);
        writeRuleFileNoFollow(rulePath, buildNotifyRuleContent(opts));
        installed = true;
        logger.debug(`[cursor-notify-rule] installed alwaysApply rule at ${rulePath}`);
    } catch (error) {
        logger.debug('[cursor-notify-rule] install failed', error);
        try {
            undoGitExclude?.();
        } catch {
            // ignore
        }
        undoGitExclude = null;
    }

    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (!registered) {
            try {
                undoGitExclude?.();
            } catch {
                // ignore
            }
            return;
        }
        try {
            let clearStateFile = false;
            withOwnershipLock(lockPath, () => {
                let state = reapOwners(readOwnershipState(statePath, absCwd));
                state.owners = state.owners.filter((owner) => owner.id !== ownerId);
                if (state.owners.length > 0) {
                    writeOwnershipState(statePath, state);
                    return;
                }

                // Last live owner. Only mutate the workspace rule if we wrote it
                // and it is still HAPI-owned (sentinel present). Mid-session user
                // replacements without the sentinel are left alone.
                if (installed) {
                    const current = existsSync(rulePath) ? safeRead(rulePath) : null;
                    const stillOurs = current === null || current.includes(HAPI_SESSION_RULE_SENTINEL);
                    if (stillOurs) {
                        if (state.snapshotTaken && state.restore !== null) {
                            writeRuleFileNoFollow(rulePath, state.restore);
                        } else if (state.snapshotTaken && state.restore === null) {
                            if (lstatSync(rulePath, { throwIfNoEntry: false })) {
                                unlinkSync(rulePath);
                            }
                        }
                    }
                }

                // Clear ownership state while still holding the lock. Do not
                // recursively delete stateDir after unlock — that races a new
                // install that already registered under the same lock.
                try {
                    if (existsSync(statePath)) {
                        unlinkSync(statePath);
                    }
                } catch {
                    // ignore
                }
                clearStateFile = true;
            });

            try {
                undoGitExclude?.();
            } catch (error) {
                logger.debug('[cursor-notify-rule] git exclude cleanup failed', error);
            }
            undoGitExclude = null;

            if (clearStateFile) {
                try {
                    if (isEmptyDir(stateDir)) {
                        rmdirSync(stateDir);
                    }
                } catch {
                    // New install may have recreated state — leave it.
                }
            }

            for (const dir of [...createdDirs].reverse()) {
                if (isEmptyDir(dir)) {
                    rmdirSync(dir);
                }
            }
        } catch (error) {
            logger.debug('[cursor-notify-rule] cleanup failed', error);
        }
    };

    return { rulePath, cleanup };
}

/** Pick the first candidate rule path that Git does not already track. */
export function resolveRuleTarget(absCwd: string): RuleTarget | null {
    for (const ruleFilename of RULE_CANDIDATES) {
        const ruleRelPosix = `.cursor/rules/${ruleFilename}`;
        if (!isGitTrackedPath(absCwd, ruleRelPosix)) {
            return {
                ruleFilename,
                ruleRelPosix,
                rulePath: join(absCwd, '.cursor', 'rules', ruleFilename)
            };
        }
    }
    return null;
}

function isGitTrackedPath(cwd: string, relPosix: string): boolean {
    const probe = spawnSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', relPosix], {
        encoding: 'utf-8',
        stdio: ['ignore', 'ignore', 'ignore']
    });
    return probe.status === 0;
}

function installGitExcludeLease(absCwd: string, rulePath: string, leaseId: string): (() => void) | null {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: absCwd,
        encoding: 'utf-8'
    });
    if (top.status !== 0) {
        return null;
    }
    const root = top.stdout.trim();
    if (!root) {
        return null;
    }
    const relRaw = relative(root, rulePath);
    if (!relRaw || relRaw.startsWith('..') || isAbsolute(relRaw)) {
        return null;
    }
    const pattern = toLiteralGitExcludePattern(relRaw);
    const excludePath = resolveGitExcludePath(root);
    if (!excludePath) {
        return null;
    }

    withExcludeLock(`${excludePath}.hapi-notify.lock`, () => {
        pruneDeadExcludeLeasesUnlocked(excludePath);
        appendExcludeLeaseUnlocked(excludePath, pattern, leaseId);
    });

    return () => {
        withExcludeLock(`${excludePath}.hapi-notify.lock`, () => {
            pruneDeadExcludeLeasesUnlocked(excludePath);
            removeExcludeLeaseUnlocked(excludePath, pattern, leaseId);
        });
    };
}

/**
 * Encode a repo-relative path as an anchored literal Git exclude pattern
 * (escape glob / character-class metacharacters; leading `/` anchors at root).
 */
export function toLiteralGitExcludePattern(relPath: string): string {
    const posix = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
    const escaped = posix
        .split('/')
        .map((segment) => {
            const escapedMeta = segment.replace(/([\\*?[\]])/g, '\\$1');
            return escapedMeta.replace(/^([#!])/, '\\$1');
        })
        .join('/');
    return `/${escaped}`;
}

function resolveGitExcludePath(root: string): string | null {
    const excludeProc = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: root,
        encoding: 'utf-8'
    });
    if (excludeProc.status !== 0) {
        return null;
    }
    const raw = excludeProc.stdout.trim();
    if (!raw) {
        return null;
    }
    return isAbsolute(raw) ? raw : resolve(root, raw);
}

function hapiNotifyGitExcludeMarker(leaseId: string): string {
    return `${HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX} ${leaseId}`;
}

function parseExcludeLeasePid(leaseId: string): number | null {
    const match = /^(\d+):/.exec(leaseId);
    if (!match) {
        return null;
    }
    const parsed = Number(match[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function appendExcludeLeaseUnlocked(excludePath: string, pattern: string, leaseId: string): void {
    const marker = hapiNotifyGitExcludeMarker(leaseId);
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    const lines = existing.split(/\r?\n/);
    if (lines.includes(marker)) {
        return;
    }
    mkdirSync(dirname(excludePath), { recursive: true });
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(excludePath, `${existing}${prefix}${marker}\n${pattern}\n`, {
        encoding: 'utf-8',
        mode: 0o644
    });
}

function removeExcludeLeaseUnlocked(excludePath: string, pattern: string, leaseId: string): void {
    if (!existsSync(excludePath)) {
        return;
    }
    const marker = hapiNotifyGitExcludeMarker(leaseId);
    const lines = readFileSync(excludePath, 'utf-8').split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === marker && lines[i + 1] === pattern) {
            i += 1;
            continue;
        }
        out.push(lines[i]!);
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    const body = out.length === 0 ? '' : `${out.join('\n')}\n`;
    writeFileSync(excludePath, body, { encoding: 'utf-8', mode: 0o644 });
}

/** Drop lease blocks whose owner PID is confirmed dead (crash recovery). */
function pruneDeadExcludeLeasesUnlocked(excludePath: string): void {
    if (!existsSync(excludePath)) {
        return;
    }
    const lines = readFileSync(excludePath, 'utf-8').split(/\r?\n/);
    const out: string[] = [];
    let removed = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith(`${HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX} `)) {
            const leaseId = line.slice(HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX.length + 1).trim();
            const leasePid = parseExcludeLeasePid(leaseId);
            if (leasePid !== null && !isProcessAlive(leasePid)) {
                removed = true;
                if (lines[i + 1] !== undefined) {
                    i += 1;
                }
                continue;
            }
        }
        out.push(line);
    }
    if (!removed) {
        return;
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    const body = out.length === 0 ? '' : `${out.join('\n')}\n`;
    writeFileSync(excludePath, body, { encoding: 'utf-8', mode: 0o644 });
}

function withExcludeLock(lockPath: string, fn: () => void): void {
    withOwnershipLock(lockPath, fn);
}

function canonicalizeExistingPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

function assertNotSymlinkPath(path: string, label: string): void {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
        throw new Error(`Refusing a symlinked ${label}: ${path}`);
    }
}

/**
 * Write without following an existing symlink: refuse links, then replace via
 * temp+rename (rename replaces a symlink inode rather than writing through it).
 */
function writeRuleFileNoFollow(path: string, contents: string): void {
    assertNotSymlinkPath(path, 'Cursor session rule');
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, contents, { encoding: 'utf-8', mode: 0o644 });
        renameSync(tmp, path);
        assertNotSymlinkPath(path, 'Cursor session rule');
    } finally {
        rmSync(tmp, { force: true });
    }
}

function getHapiHomeDir(): string {
    const fromEnv = process.env.HAPI_HOME?.trim();
    if (fromEnv) {
        const expanded = fromEnv.replace(/^~(?=$|[/\\])/, homedir());
        return isAbsolute(expanded) ? expanded : resolve(expanded);
    }
    return join(homedir(), '.hapi');
}

function getOverlayStateDir(absCwd: string, ruleRelPosix: string): string {
    const hash = createHash('sha256').update(`${absCwd}\0${ruleRelPosix}`).digest('hex').slice(0, 24);
    return join(getHapiHomeDir(), 'cursor-notify-overlays', hash);
}

function emptyOwnershipState(absCwd: string): OverlayOwnershipState {
    return { cwd: absCwd, owners: [], snapshotTaken: false, restore: null };
}

function readOwnershipState(path: string, absCwd: string): OverlayOwnershipState {
    const raw = safeRead(path);
    if (!raw) {
        return emptyOwnershipState(absCwd);
    }
    try {
        const parsed = JSON.parse(raw) as Partial<OverlayOwnershipState>;
        const owners: OverlayOwner[] = [];
        if (Array.isArray(parsed.owners)) {
            for (const entry of parsed.owners) {
                if (
                    entry
                    && typeof entry === 'object'
                    && typeof (entry as OverlayOwner).id === 'string'
                    && typeof (entry as OverlayOwner).pid === 'number'
                    && Number.isFinite((entry as OverlayOwner).pid)
                ) {
                    owners.push({ id: (entry as OverlayOwner).id, pid: (entry as OverlayOwner).pid });
                }
            }
        }
        const snapshotTaken = parsed.snapshotTaken === true
            || typeof parsed.restore === 'string'
            || owners.length > 0;
        return {
            cwd: absCwd,
            owners,
            snapshotTaken,
            restore: typeof parsed.restore === 'string' ? parsed.restore : null
        };
    } catch {
        return emptyOwnershipState(absCwd);
    }
}

function writeOwnershipState(path: string, state: OverlayOwnershipState): void {
    writeFileSync(path, JSON.stringify(state), 'utf-8');
}

function reapOwners(state: OverlayOwnershipState): OverlayOwnershipState {
    return {
        ...state,
        owners: state.owners.filter((owner) => isProcessAlive(owner.pid))
    };
}

function withOwnershipLock(lockPath: string, fn: () => void): void {
    const started = Date.now();
    while (true) {
        try {
            mkdirSync(dirname(lockPath), { recursive: true });
            const fd = openSync(lockPath, 'wx');
            try {
                fn();
            } finally {
                closeSync(fd);
                try {
                    unlinkSync(lockPath);
                } catch {
                    // ignore
                }
            }
            return;
        } catch (error) {
            if (Date.now() - started >= OWNERSHIP_LOCK_TIMEOUT_MS) {
                throw error;
            }
            sleepSync(20);
        }
    }
}

function sleepSync(ms: number): void {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, ms);
}

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        return null;
    }
}

function isEmptyDir(path: string): boolean {
    try {
        return readdirSync(path).length === 0;
    } catch {
        return false;
    }
}

/**
 * Keep only characters safe to bake into a JSON string example (no quotes/braces/
 * newlines). Returns null for empty/whitespace so callers fall back to the
 * placeholder token.
 */
function sanitizeToken(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[^A-Za-z0-9._\- /]/g, '').trim();
    return cleaned.length > 0 ? cleaned : null;
}
