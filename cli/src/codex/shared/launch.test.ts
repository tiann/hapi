import { describe, expect, it } from 'vitest';
import { sharedLaunchConfig } from './launch';
import { parseCodexCliOverrides } from '../utils/codexCliOverrides';
import { resolveCodexPermissionModeConfig } from '../utils/permissionModeConfig';

describe('shared launch configuration', () => {
    it.each(['default', 'read-only', 'yolo'] as const)('keeps explicit %s authoritative over native permission flags', permissionMode => {
        for (const flags of [
            ['--yolo'], ['--dangerously-bypass-approvals-and-sandbox'], ['--full-auto'],
            ['-sdanger-full-access', '-aon-request'], ['--sandbox=read-only', '--ask-for-approval=untrusted'],
            ['--approve-for-me'], ['--not-so-yolo'],
            ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'approvals_reviewer="auto_review"']
        ]) {
            const result = sharedLaunchConfig({ permissionMode, codexArgs: [...flags, '--no-alt-screen', '--', '--yolo'] }, '/tmp');
            const { approvalPolicy, sandbox } = resolveCodexPermissionModeConfig(permissionMode);
            expect(result.threadParams).toMatchObject({ approvalPolicy, sandbox, approvalsReviewer: 'user' });
            expect(parseCodexCliOverrides(result.tuiArgs)).toEqual({});
            expect(result.tuiArgs).toEqual(['--no-alt-screen', '--', '--yolo']);
            expect(result.tuiArgs.slice(-2)).toEqual(['--', '--yolo']);
            expect(result.tuiArgs).toContain('--no-alt-screen');
            expect(result.tuiArgs.slice(0, -2)).not.toContain('--yolo');
            expect(result.serverArgs.slice(-6)).toEqual([
                '-c', `approval_policy=${JSON.stringify(approvalPolicy)}`,
                '-c', `sandbox_mode=${JSON.stringify(sandbox)}`, '-c', 'approvals_reviewer="user"'
            ]);
        }
    });
    it('keeps unspecified settings inherited and explicit Standard distinct', () => {
        expect(sharedLaunchConfig({}, '/tmp').threadParams).not.toHaveProperty('serviceTier');
        expect(sharedLaunchConfig({}, '/tmp').threadParams.config).not.toHaveProperty('model_reasoning_effort');
        expect(sharedLaunchConfig({ serviceTier: 'standard' }, '/tmp').threadParams.serviceTier).toBeNull();
        expect(sharedLaunchConfig({ serviceTier: 'fast' }, '/tmp').threadParams.serviceTier).toBe('priority');
    });
    it('normalizes short flags, forwards configuration and resolves cwd exactly once', () => {
        const result = sharedLaunchConfig({ codexArgs: ['-C', 'project', '-mcustom', '-a', 'never', '--search', '--add-dir', '../extra', '-c', 'model_reasoning_effort="high"'] }, '/tmp');
        expect(result.cwd).toBe('/tmp/project'); expect(result.tuiArgs).not.toContain('-C');
        expect(result.threadParams).toMatchObject({ model: 'custom', approvalPolicy: 'never', config: { web_search: 'live', 'sandbox_workspace_write.writable_roots': ['/tmp/extra'] } });
        expect(result.serverArgs).toContain('model_reasoning_effort="high"');
    });
    it('rejects unsupported flags before starting an execution rather than silently ignoring them', () => {
        for (const args of [['-pwork'], ['--profile=work'], ['--remote=ws://other'], ['--worktree'], ['--oss'], ['-m']]) {
            expect(() => sharedLaunchConfig({ codexArgs: args }, '/tmp')).toThrow();
        }
    });
    it('does not interpret flags after -- as configuration', () => {
        expect(sharedLaunchConfig({ codexArgs: ['--', '--profile=explain'] }, '/tmp').tuiArgs).toEqual(['--', '--profile=explain']);
        expect(sharedLaunchConfig({ codexArgs: ['--', '-C', 'literal'] }, '/tmp').tuiArgs).toEqual(['--', '-C', 'literal']);
        expect(() => sharedLaunchConfig({ permissionMode: 'safe-yolo' }, '/tmp')).toThrow('not a native shared');
    });
    it('preserves launch-time provider and automatic-review policy', () => {
        const result = sharedLaunchConfig({ codexArgs: ['--oss', '--local-provider', 'ollama', '--approve-for-me'] }, '/tmp');
        expect(result.threadParams).toMatchObject({ modelProvider: 'ollama', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' });
    });
});
