import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachedOptionsSchema, assertAttachableRoot, requireLoadedThread, validateAttachedEndpoint } from './attached';
import type { CodexAppServerClient } from '../codexAppServerClient';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
describe('explicit external attachment preflight', () => {
    it.each(['ws://localhost:1', 'unix://relative.sock', '/tmp/socket', 'unix:///tmp/a\n'])('rejects non-local or malformed endpoint %s', async endpoint => {
        await expect(validateAttachedEndpoint(endpoint)).rejects.toThrow('Attach requires');
    });
    it.skipIf(process.platform === 'win32')('accepts a private same-user socket and official-style symlink, refuses unsafe modes and files', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-attach-preflight-'));
        cleanup.push(() => rm(home, { recursive: true, force: true }));
        await chmod(home, 0o700);
        const path = join(home, 'engine.sock'); const server = createServer();
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
        cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
        await chmod(path, 0o600);
        const link = join(home, 'daemon.sock'); await symlink(path, link);
        expect(await validateAttachedEndpoint(`unix://${link}`)).toBe(`unix://${await realpath(path)}`);
        await chmod(path, 0o660);
        await expect(validateAttachedEndpoint(`unix://${path}`)).rejects.toThrow('same-user');
        await chmod(path, 0o600); await chmod(home, 0o777);
        await expect(validateAttachedEndpoint(`unix://${path}`)).rejects.toThrow('same-user');
        await chmod(home, 0o700); const regular = join(home, 'file'); await writeFile(regular, '');
        await expect(validateAttachedEndpoint(`unix://${regular}`)).rejects.toThrow('same-user');
    });
    it('paginates loaded threads without ever sending a resume or start', async () => {
        const request = vi.fn().mockResolvedValueOnce({ data: ['other'], nextCursor: 'next' }).mockResolvedValueOnce({ data: ['root'] });
        await requireLoadedThread({ request } as unknown as CodexAppServerClient, 'root');
        expect(request.mock.calls).toEqual([['thread/loaded/list', { cursor: undefined }], ['thread/loaded/list', { cursor: 'next' }]]);
        request.mockResolvedValue({ data: [] });
        await expect(requireLoadedThread({ request } as unknown as CodexAppServerClient, 'absent')).rejects.toThrow('not loaded');
    });
    it('only accepts persistent roots and strict non-injecting options', () => {
        const thread = { id: 'root', cwd: '/tmp/work', source: 'vscode' };
        expect(assertAttachableRoot(thread, 'root')).toBe('/tmp/work');
        for (const change of [{ id: 'other' }, { cwd: 'relative' }, { parentThreadId: 'parent' }, { ephemeral: true }, { source: { subAgent: {} } }]) {
            expect(() => assertAttachableRoot({ ...thread, ...change }, 'root')).toThrow();
        }
        expect(() => AttachedOptionsSchema.parse({ endpoint: 'unix:///tmp/a', threadId: 'root', permissionMode: 'yolo' })).toThrow();
    });
});
