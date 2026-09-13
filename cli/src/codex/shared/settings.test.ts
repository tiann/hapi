import { describe, expect, it } from 'vitest';
import { inheritedSandbox, settingsMatch } from './settings';

describe('native shared settings', () => {
    it('does not acknowledge another client changing an unrelated field', () => {
        expect(settingsMatch({ model: 'a', effort: 'high' }, { threadId: 't', model: 'b' })).toBe(false);
        expect(settingsMatch({ model: 'b', effort: 'high' }, { threadId: 't', model: 'b' })).toBe(true);
        expect(settingsMatch({ serviceTier: 'priority' }, { serviceTier: null })).toBe(false);
    });
    it('matches collaboration settings including model and effort, but accepts expanded built-in instructions', () => {
        const expected = { collaborationMode: { mode: 'plan', settings: { model: 'b', reasoning_effort: 'high', developer_instructions: null } } };
        expect(settingsMatch({ collaborationMode: { mode: 'plan', settings: { model: 'a', reasoning_effort: 'high' } } }, expected)).toBe(false);
        expect(settingsMatch({ collaborationMode: { mode: 'plan', settings: { model: 'b', reasoning_effort: 'high', developer_instructions: 'native instructions' } } }, expected)).toBe(true);
    });
    it('preserves workspace sandbox restrictions and never widens an external or named profile', () => {
        expect(inheritedSandbox({ sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false,
            excludeTmpdirEnvVar: true, excludeSlashTmp: true } })).toEqual({ sandbox: 'workspace-write', config: {
            'sandbox_workspace_write.writable_roots': ['/project'], 'sandbox_workspace_write.network_access': false,
            'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true
        } });
        expect(() => inheritedSandbox({ sandboxPolicy: { type: 'externalSandbox' } })).toThrow('Cannot inherit');
        expect(() => inheritedSandbox({ activePermissionProfile: { id: 'restricted' } })).toThrow('named permission profile');
    });
});
