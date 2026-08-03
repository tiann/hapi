import { basename, join } from 'node:path';
import { realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { getHapiBlobsDir } from '@/constants/uploadPaths';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { readBoundedAttachmentFile } from '../attachmentFile';
import { cleanupUploadDir, isAuthorizedUploadFile, isPathWithinUploadDir, registerUploadHandlers } from './uploads';

describe('isPathWithinUploadDir', () => {
    it('accepts only paths under the matching session upload directory', () => {
        const sessionId = 'session-allowed';
        const ownUpload = join(getHapiBlobsDir(), `${sessionId}-random`, 'image.png');
        const otherUpload = join(getHapiBlobsDir(), 'session-other-random', 'image.png');

        expect(isPathWithinUploadDir(ownUpload, sessionId)).toBe(true);
        expect(isPathWithinUploadDir(otherUpload, sessionId)).toBe(false);
        expect(isPathWithinUploadDir('/etc/hosts', sessionId)).toBe(false);
    });

    it('binds authorization to the uploaded file identity, not only its path', async () => {
        const handlers = new Map<string, (payload: any) => Promise<any>>();
        registerUploadHandlers({
            registerHandler: (method: string, handler: (payload: any) => Promise<any>) => handlers.set(method, handler),
        } as never);
        const sessionId = `session-identity-${Date.now()}`;
        const upload = handlers.get(RPC_METHODS.UploadFile)!;
        let path: string | null = null;
        try {
            const result = await upload({
                sessionId,
                filename: 'image.png',
                mimeType: 'image/png',
                content: Buffer.from([1, 2, 3, 4]).toString('base64'),
            });
            expect(result).toMatchObject({ success: true });
            path = result.path;
            const original = await stat(path!);
            expect(isAuthorizedUploadFile(path!, sessionId, original)).toBe(true);
            expect(isAuthorizedUploadFile(path!, 'another-session', original)).toBe(false);
            // The lexical upload path can canonicalize differently (notably
            // /var -> /private/var on Darwin). Authorization and opened-file
            // identity deliberately use the exact registered path.
            expect(await readBoundedAttachmentFile(
                path!,
                50 * 1024 * 1024,
                (identity) => isAuthorizedUploadFile(path!, sessionId, identity),
            )).toEqual(Buffer.from([1, 2, 3, 4]));
            expect(typeof await realpath(path!)).toBe('string');

            const replacementPath = `${path!}.replacement`;
            await writeFile(replacementPath, Buffer.from([5, 6, 7, 8]));
            const distinctReplacement = await stat(replacementPath);
            expect(`${distinctReplacement.dev}:${distinctReplacement.ino}`).not.toBe(`${original.dev}:${original.ino}`);
            await rm(path!, { force: true });
            await rename(replacementPath, path!);
            const replacement = await stat(path!);
            expect(isAuthorizedUploadFile(path!, sessionId, replacement)).toBe(false);
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('supports concurrent uploads with the same filename using distinct exclusive paths', async () => {
        const handlers = new Map<string, (payload: any) => Promise<any>>();
        registerUploadHandlers({
            registerHandler: (method: string, handler: (payload: any) => Promise<any>) => handlers.set(method, handler),
        } as never);
        const sessionId = `session-concurrent-${Date.now()}`;
        const upload = handlers.get(RPC_METHODS.UploadFile)!;
        try {
            const payload = {
                sessionId,
                filename: 'screenshot.png',
                mimeType: 'image/png',
                content: Buffer.from([1, 2, 3, 4]).toString('base64'),
            };
            const [first, second] = await Promise.all([upload(payload), upload(payload)]);

            expect(first).toMatchObject({ success: true });
            expect(second).toMatchObject({ success: true });
            expect(first.path).not.toBe(second.path);
            expect(isAuthorizedUploadFile(first.path, sessionId, await stat(first.path))).toBe(true);
            expect(isAuthorizedUploadFile(second.path, sessionId, await stat(second.path))).toBe(true);
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('keeps long ASCII and Unicode filename components within 255 UTF-8 bytes', async () => {
        const handlers = new Map<string, (payload: any) => Promise<any>>();
        registerUploadHandlers({
            registerHandler: (method: string, handler: (payload: any) => Promise<any>) => handlers.set(method, handler),
        } as never);
        const sessionId = `session-long-name-${Date.now()}`;
        const upload = handlers.get(RPC_METHODS.UploadFile)!;
        try {
            for (const filename of [`${'a'.repeat(300)}.png`, `${'😀'.repeat(300)}.png`]) {
                const result = await upload({
                    sessionId,
                    filename,
                    mimeType: 'image/png',
                    content: Buffer.from([1]).toString('base64'),
                });
                expect(result).toMatchObject({ success: true });
                expect(Buffer.byteLength(basename(result.path))).toBeLessThanOrEqual(255);
                expect(basename(result.path)).toMatch(/\.png$/);
            }
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('preserves an extension that exactly fills the remaining component budget', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const handlers = new Map<string, (payload: any) => Promise<any>>();
        registerUploadHandlers({
            registerHandler: (method: string, handler: (payload: any) => Promise<any>) => handlers.set(method, handler),
        } as never);
        const sessionId = 'session-exact-extension';
        const upload = handlers.get(RPC_METHODS.UploadFile)!;
        // At time 0 the prefix is `0-<36-byte UUID>-` (39 bytes), leaving 216.
        const extension = `.${'e'.repeat(215)}`;
        try {
            const result = await upload({
                sessionId,
                filename: `x${extension}`,
                mimeType: 'application/octet-stream',
                content: Buffer.from([1]).toString('base64'),
            });
            expect(result).toMatchObject({ success: true });
            expect(Buffer.byteLength(basename(result.path))).toBe(255);
            expect(basename(result.path).endsWith(extension)).toBe(true);
        } finally {
            vi.useRealTimers();
            await cleanupUploadDir(sessionId);
        }
    });
});
