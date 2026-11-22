import { describe, expect, it } from 'vitest';
import { attachedRuntimeControl, startAttachedControl } from './attachedControl';
import type { CodexRuntimeRecord } from './registry';

describe('attached worker control', () => {
    it('authenticates local detach and refuses native proxying or remote control endpoints', async () => {
        let detached = false;
        const control = await startAttachedControl('sid', () => { detached = true; });
        try {
            expect((await fetch(`${control.endpoint}/detach/sid`, { method: 'POST' })).status).toBe(401);
            expect((await fetch(`${control.endpoint}/native-rpc`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}` } })).status).toBe(404);
            expect(detached).toBe(false);
            const runtime: CodexRuntimeRecord = { id: 'test', pid: process.pid, marker: 'test', kind: 'attached',
                command: '', args: [], codexHome: '/tmp/test', hub: 'test', authHash: 'test', endpoint: control.endpoint,
                token: control.token, sessions: { sid: { threadId: 'native', namespace: 'test', active: true } } };
            await expect(attachedRuntimeControl(runtime, 'hapi/attach', 'sid')).rejects.toThrow('only support detach');
            await expect(attachedRuntimeControl({ ...runtime, endpoint: 'http://example.com' }, 'hapi/detach', 'sid')).rejects.toThrow('Invalid');
            expect(await attachedRuntimeControl(runtime, 'hapi/stopSession', 'sid')).toEqual({ success: true });
            expect(detached).toBe(true);
        } finally { await control.close(); }
    });
});
