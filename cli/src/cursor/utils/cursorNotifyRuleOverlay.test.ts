import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SESSION_SUMMARY_CONTRACT_LINE } from '@/modules/common/sessionSummaryInstruction';
import {
    buildNotifyRuleContent,
    HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX,
    HAPI_SESSION_RULE_SENTINEL,
    installCursorNotifyRuleOverlay,
    RULE_FILENAME_ALTERNATE,
    RULE_FILENAME_PRIMARY
} from './cursorNotifyRuleOverlay';

describe('buildNotifyRuleContent', () => {
    it('includes alwaysApply frontmatter, sentinel, and the contract line', () => {
        const content = buildNotifyRuleContent();
        expect(content.startsWith('---\nalwaysApply: true\n---')).toBe(true);
        expect(content).toContain(HAPI_SESSION_RULE_SENTINEL);
        expect(content).toContain(SESSION_SUMMARY_CONTRACT_LINE);
        expect(content).toContain('"status":"done|blocked|needs_review|needs_decision|failed|stalled"');
        expect(content.toLowerCase()).toContain('omit the action key');
        expect(content).toContain('Never emit "action":""');
        expect(content).toContain('final answer only');
        expect(content).toContain('After status "done", do not emit further user-visible replies');
        expect(content).not.toContain('End every response');
    });

    it('bakes in project and agent id when provided', () => {
        const content = buildNotifyRuleContent({ project: 'status-summary-emit', agentId: 'peer-7' });
        expect(content).toContain('"agent":"peer-7"');
        expect(content).toContain('"project":"status-summary-emit"');
    });

    it('falls back to placeholders and sanitizes hostile input', () => {
        const content = buildNotifyRuleContent({ project: '"}{evil', agentId: '   ' });
        expect(content).toContain('"agent":"<agent-id>"');
        expect(content).toContain('"project":"evil"');
    });

    it('reads as benign session tracking, never surveillance', () => {
        const content = buildNotifyRuleContent().toLowerCase();
        expect(content).toContain('session tracking');
        expect(content).not.toContain('overseer');
        expect(content).not.toContain('surveillance');
        expect(content).not.toContain('monitor');
    });
});

describe('installCursorNotifyRuleOverlay', () => {
    let cwd: string;
    let hapiHome: string;
    let previousHapiHome: string | undefined;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), 'hapi-notify-rule-'));
        hapiHome = mkdtempSync(join(tmpdir(), 'hapi-home-'));
        previousHapiHome = process.env.HAPI_HOME;
        process.env.HAPI_HOME = hapiHome;
    });

    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(hapiHome, { recursive: true, force: true });
        if (previousHapiHome === undefined) {
            delete process.env.HAPI_HOME;
        } else {
            process.env.HAPI_HOME = previousHapiHome;
        }
    });

    const rulePathOf = (root: string) => join(root, '.cursor', 'rules', 'hapi-session.mdc');

    it('keeps ownership state outside the workspace', () => {
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        writeFileSync(rulePathOf(cwd), '# tracked\n', 'utf-8');
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        expect(existsSync(join(cwd, '.cursor', 'rules', 'hapi-session.mdc.hapi-refs'))).toBe(false);
        expect(existsSync(join(cwd, '.cursor', 'rules', 'hapi-session.mdc.hapi-restore'))).toBe(false);
        expect(readdirSync(hapiHome).length).toBeGreaterThan(0);
        overlay.cleanup();
    });

    it('writes the rule file and reports its path', () => {
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        expect(overlay.rulePath).toBe(rulePathOf(cwd));
        expect(existsSync(overlay.rulePath)).toBe(true);
        expect(readFileSync(overlay.rulePath, 'utf-8')).toContain(HAPI_SESSION_RULE_SENTINEL);
    });

    it('cleanup removes our file and prunes dirs it created', () => {
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        overlay.cleanup();
        expect(existsSync(overlay.rulePath)).toBe(false);
        expect(existsSync(join(cwd, '.cursor', 'rules'))).toBe(false);
        expect(existsSync(join(cwd, '.cursor'))).toBe(false);
    });

    it('backs up and restores a pre-existing user rule verbatim', () => {
        const rulePath = rulePathOf(cwd);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        const userContent = '---\nalwaysApply: false\n---\n# my own rule\n';
        writeFileSync(rulePath, userContent, 'utf-8');

        const overlay = installCursorNotifyRuleOverlay({ cwd });
        expect(readFileSync(rulePath, 'utf-8')).toContain(HAPI_SESSION_RULE_SENTINEL);

        overlay.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toBe(userContent);
        expect(existsSync(join(cwd, '.cursor', 'rules'))).toBe(true);
    });

    it('does not prune a .cursor dir that has other content', () => {
        mkdirSync(join(cwd, '.cursor'), { recursive: true });
        writeFileSync(join(cwd, '.cursor', 'mcp.json'), '{}', 'utf-8');

        const overlay = installCursorNotifyRuleOverlay({ cwd });
        overlay.cleanup();

        expect(existsSync(overlay.rulePath)).toBe(false);
        expect(existsSync(join(cwd, '.cursor', 'rules'))).toBe(false);
        expect(existsSync(join(cwd, '.cursor'))).toBe(true);
        expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(true);
    });

    it('restores a pre-existing tracked/user file after overlay cleanup', () => {
        const rulePath = rulePathOf(cwd);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        const prior = '# tracked repo rule\nalwaysApply: false\n';
        writeFileSync(rulePath, prior, 'utf-8');

        const overlay = installCursorNotifyRuleOverlay({ cwd, project: 'session' });
        expect(readFileSync(rulePath, 'utf-8')).toContain('"project":"session"');

        overlay.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toBe(prior);
    });

    it('last concurrent cleanup restores the original, not the peer overlay', () => {
        const rulePath = rulePathOf(cwd);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        const tracked = buildNotifyRuleContent({ project: 'tracked-repo', agentId: 'repo' });
        writeFileSync(rulePath, tracked, 'utf-8');

        const first = installCursorNotifyRuleOverlay({ cwd, project: 'older', agentId: 'a' });
        const second = installCursorNotifyRuleOverlay({ cwd, project: 'newer', agentId: 'b' });
        expect(readFileSync(rulePath, 'utf-8')).toContain('"project":"newer"');

        first.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toContain('"project":"newer"');

        second.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toBe(tracked);
    });

    it('deletes generated rule after crash recovery when no prior file existed', () => {
        const rulePath = rulePathOf(cwd);
        installCursorNotifyRuleOverlay({ cwd, project: 'crash' });
        expect(existsSync(rulePath)).toBe(true);

        const overlayRoot = join(hapiHome, 'cursor-notify-overlays');
        const stateDirName = readdirSync(overlayRoot)[0];
        expect(stateDirName).toBeTruthy();
        const statePath = join(overlayRoot, stateDirName!, 'state.json');
        const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
            owners: Array<{ id: string; pid: number }>
            snapshotTaken: boolean
            restore: string | null
        };
        expect(state.snapshotTaken).toBe(true);
        expect(state.restore).toBeNull();
        state.owners = [{ id: 'dead', pid: 2_147_483_646 }];
        writeFileSync(statePath, JSON.stringify(state));

        const recovered = installCursorNotifyRuleOverlay({ cwd, project: 'after' });
        recovered.cleanup();
        expect(existsSync(rulePath)).toBe(false);
    });

    it('installs the alternate rule when the primary path is git-tracked', () => {
        const primary = rulePathOf(cwd);
        const alternate = join(cwd, '.cursor', 'rules', RULE_FILENAME_ALTERNATE);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        const tracked = [
            '---',
            'alwaysApply: true',
            '---',
            HAPI_SESSION_RULE_SENTINEL,
            '',
            '# Session status summary',
            '',
            'Tracked repo copy.',
            ''
        ].join('\n');
        writeFileSync(primary, tracked, 'utf-8');
        execFileSync('git', ['init'], { cwd });
        execFileSync('git', ['add', `.cursor/rules/${RULE_FILENAME_PRIMARY}`], { cwd });

        const overlay = installCursorNotifyRuleOverlay({ cwd, project: 'alt' });
        expect(readFileSync(primary, 'utf-8')).toBe(tracked);
        expect(overlay.rulePath).toBe(alternate);
        expect(readFileSync(alternate, 'utf-8')).toContain('"project":"alt"');
        overlay.cleanup();
        expect(readFileSync(primary, 'utf-8')).toBe(tracked);
        expect(existsSync(alternate)).toBe(false);
    });

    it('preserves a mid-session user replacement across another live install', () => {
        const rulePath = rulePathOf(cwd);
        const first = installCursorNotifyRuleOverlay({ cwd, project: 'alive' });
        const userReplacement = '# operator replaced while A still live\n';
        writeFileSync(rulePath, userReplacement, 'utf-8');

        const second = installCursorNotifyRuleOverlay({ cwd, project: 'peer' });
        expect(readFileSync(rulePath, 'utf-8')).toContain('"project":"peer"');

        first.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toContain('"project":"peer"');
        second.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toBe(userReplacement);
    });

    it('scopes restore snapshots to the selected rule path', () => {
        const primary = rulePathOf(cwd);
        const alternate = join(cwd, '.cursor', 'rules', RULE_FILENAME_ALTERNATE);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        const altUser = '# pre-existing alternate user rule\n';
        writeFileSync(alternate, altUser, 'utf-8');
        writeFileSync(primary, '# primary will be tracked\n', 'utf-8');
        execFileSync('git', ['init'], { cwd });
        execFileSync('git', ['add', `.cursor/rules/${RULE_FILENAME_PRIMARY}`], { cwd });

        const overlay = installCursorNotifyRuleOverlay({ cwd, project: 'scoped' });
        expect(overlay.rulePath).toBe(alternate);
        expect(readFileSync(alternate, 'utf-8')).toContain('"project":"scoped"');
        overlay.cleanup();
        expect(readFileSync(alternate, 'utf-8')).toBe(altUser);
    });

    it('reaps git exclude leases left by crashed sessions', () => {
        execFileSync('git', ['init'], { cwd });
        const excludePath = join(cwd, '.git', 'info', 'exclude');
        mkdirSync(dirname(excludePath), { recursive: true });
        const deadLease = `${HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX} 2147483646:dead-lease\n.cursor/rules/${RULE_FILENAME_PRIMARY}\n`;
        writeFileSync(excludePath, `# keep-me\n${deadLease}`, 'utf-8');

        const overlay = installCursorNotifyRuleOverlay({ cwd, project: 'reap' });
        const mid = readFileSync(excludePath, 'utf-8');
        expect(mid).toContain('# keep-me');
        expect(mid).not.toContain('2147483646:dead-lease');
        expect(mid).toContain(HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX);

        overlay.cleanup();
        expect(readFileSync(excludePath, 'utf-8')).toBe('# keep-me\n');
    });

    it('restores a post-crash user replacement instead of a stale snapshot', () => {
        const rulePath = rulePathOf(cwd);
        installCursorNotifyRuleOverlay({ cwd, project: 'crash' });
        expect(existsSync(rulePath)).toBe(true);

        const overlayRoot = join(hapiHome, 'cursor-notify-overlays');
        const stateDirName = readdirSync(overlayRoot)[0];
        expect(stateDirName).toBeTruthy();
        const statePath = join(overlayRoot, stateDirName!, 'state.json');
        const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
            owners: Array<{ id: string; pid: number }>
            snapshotTaken: boolean
            restore: string | null
        };
        expect(state.restore).toBeNull();
        state.owners = [{ id: 'dead', pid: 2_147_483_646 }];
        writeFileSync(statePath, JSON.stringify(state));

        const userReplacement = '# operator replaced generated rule after crash\n';
        writeFileSync(rulePath, userReplacement, 'utf-8');

        const recovered = installCursorNotifyRuleOverlay({ cwd, project: 'after' });
        expect(readFileSync(rulePath, 'utf-8')).toContain('"project":"after"');
        recovered.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toBe(userReplacement);
    });

    it('excludes the transient rule from ordinary git staging', () => {
        execFileSync('git', ['init'], { cwd });
        const overlay = installCursorNotifyRuleOverlay({ cwd, project: 'stage' });
        const exclude = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf-8');
        expect(exclude).toContain(HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX);
        expect(exclude).toContain(`.cursor/rules/${RULE_FILENAME_PRIMARY}`);

        const ignored = execFileSync(
            'git',
            ['-C', cwd, 'check-ignore', '-v', `--`, `.cursor/rules/${RULE_FILENAME_PRIMARY}`],
            { encoding: 'utf-8' }
        );
        expect(ignored).toContain(`.cursor/rules/${RULE_FILENAME_PRIMARY}`);

        overlay.cleanup();
        const after = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf-8');
        expect(after).not.toContain(HAPI_NOTIFY_GIT_EXCLUDE_MARKER_PREFIX);
    });

    it('preserves pre-existing .git/info/exclude rules across install and cleanup', () => {
        execFileSync('git', ['init'], { cwd });
        const excludePath = join(cwd, '.git', 'info', 'exclude');
        writeFileSync(excludePath, '# keep-me\nlocal-notes.txt\n', 'utf-8');
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        overlay.cleanup();
        expect(readFileSync(excludePath, 'utf-8')).toBe('# keep-me\nlocal-notes.txt\n');
    });

    it('clears ownership state without recursively deleting a concurrent install dir', () => {
        const first = installCursorNotifyRuleOverlay({ cwd, project: 'first' });
        first.cleanup();

        const second = installCursorNotifyRuleOverlay({ cwd, project: 'second' });
        expect(readFileSync(second.rulePath, 'utf-8')).toContain('"project":"second"');
        // Simulate last-owner cleanup racing a live peer: second still owns the cwd.
        const third = installCursorNotifyRuleOverlay({ cwd, project: 'third' });
        second.cleanup();
        expect(readFileSync(third.rulePath, 'utf-8')).toContain('"project":"third"');
        third.cleanup();
        expect(existsSync(third.rulePath)).toBe(false);
    });

    it('preserves mid-session user replacement without sentinel', () => {
        const rulePath = rulePathOf(cwd);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        writeFileSync(rulePath, '# prior\n', 'utf-8');
        const overlay = installCursorNotifyRuleOverlay({ cwd, project: 'sess' });
        const userReplacement = '# user replaced mid-session\n';
        writeFileSync(rulePath, userReplacement, 'utf-8');
        overlay.cleanup();
        expect(readFileSync(rulePath, 'utf-8')).toBe(userReplacement);
    });

    it('resolves relative HAPI_HOME to an absolute path', () => {
        const relName = `hapi-overlay-home-${Date.now()}`;
        process.env.HAPI_HOME = relName;
        const absHome = resolve(relName);
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
        writeFileSync(rulePathOf(cwd), '# tracked\n', 'utf-8');
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        expect(existsSync(join(absHome, 'cursor-notify-overlays'))).toBe(true);
        overlay.cleanup();
        rmSync(absHome, { recursive: true, force: true });
    });

    it('never deletes a user file that replaced ours mid-session', () => {
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        const userContent = 'the user clobbered our rule with their own\n';
        writeFileSync(overlay.rulePath, userContent, 'utf-8');

        overlay.cleanup();
        expect(readFileSync(overlay.rulePath, 'utf-8')).toBe(userContent);
    });

    it('cleanup is idempotent', () => {
        const overlay = installCursorNotifyRuleOverlay({ cwd });
        overlay.cleanup();
        expect(() => overlay.cleanup()).not.toThrow();
        expect(existsSync(overlay.rulePath)).toBe(false);
    });
});
