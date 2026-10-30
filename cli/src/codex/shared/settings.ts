import { isDeepStrictEqual } from 'node:util';
import { record } from './gateway';

/** Native updates are asynchronous; an unrelated notification is not our ACK. */
export function settingsMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
    return Object.entries(expected).every(([key, value]) => {
        if (key === 'threadId') return true;
        // null developer instructions select the native built-in instructions;
        // the effective snapshot is allowed to contain their expanded text.
        if (key === 'developer_instructions' && value === null) return true;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            return settingsMatch(record(actual[key]), record(value));
        }
        return isDeepStrictEqual(actual[key], value);
    });
}

/** Never silently convert a named/external sandbox into workspace-write. */
export function inheritedSandbox(settings: Record<string, unknown>): Record<string, unknown> {
    if (settings.activePermissionProfile) throw new Error('Create this conversation in the native TUI: named permission profile inheritance is not supported');
    const sandbox = record(settings.sandboxPolicy ?? settings.sandbox);
    if (!sandbox.type) return {};
    if (sandbox.type === 'dangerFullAccess') return { sandbox: 'danger-full-access' };
    if (sandbox.type === 'readOnly') {
        // Native readOnly can carry a restricted filesystem view, which the
        // public thread/start sandbox enum cannot express.
        if (sandbox.access && record(sandbox.access).type !== 'fullAccess') throw new Error('Cannot inherit a restricted read-only filesystem; create this conversation in the native TUI');
        return { sandbox: 'read-only' };
    }
    if (sandbox.type !== 'workspaceWrite') throw new Error(`Cannot inherit sandbox ${String(sandbox.type)}; create this conversation in the native TUI`);
    return { sandbox: 'workspace-write', config: {
        ...(Array.isArray(sandbox.writableRoots) ? { 'sandbox_workspace_write.writable_roots': sandbox.writableRoots } : {}),
        ...(typeof sandbox.networkAccess === 'boolean' ? { 'sandbox_workspace_write.network_access': sandbox.networkAccess } : {}),
        ...(typeof sandbox.excludeTmpdirEnvVar === 'boolean' ? { 'sandbox_workspace_write.exclude_tmpdir_env_var': sandbox.excludeTmpdirEnvVar } : {}),
        ...(typeof sandbox.excludeSlashTmp === 'boolean' ? { 'sandbox_workspace_write.exclude_slash_tmp': sandbox.excludeSlashTmp } : {})
    } };
}
