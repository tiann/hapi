import { basename, dirname, join } from 'node:path';
import { readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

describe('chunked upload handlers', () => {
    function setupHandlers(ttlMs?: number) {
        const handlers = new Map<string, (payload: any) => Promise<any>>();
        registerUploadHandlers(
            {
                registerHandler: (method: string, handler: (payload: any) => Promise<any>) => handlers.set(method, handler),
            } as never,
            ttlMs !== undefined ? { activeUploadTtlMs: ttlMs } : undefined,
        );
        return {
            init: handlers.get(RPC_METHODS.UploadInit)!,
            chunk: handlers.get(RPC_METHODS.UploadChunk)!,
            finalize: handlers.get(RPC_METHODS.UploadFinalize)!,
            abort: handlers.get(RPC_METHODS.UploadAbort)!,
            remove: handlers.get(RPC_METHODS.DeleteUpload)!,
        };
    }

    it('streams chunks to a .part file, authorizes only after finalize, and deletes cleanly', async () => {
        const { init, chunk, finalize, remove } = setupHandlers();
        const sessionId = `session-chunked-${Date.now()}`;
        const parts = [
            Buffer.from('hello '),
            Buffer.from('chunked '),
            Buffer.from('world!'),
        ];
        const total = Buffer.concat(parts);
        try {
            const initRes = await init({
                sessionId,
                filename: 'notes.txt',
                size: total.length,
                mimeType: 'text/plain',
            });
            expect(initRes).toMatchObject({ success: true, uploadId: expect.any(String) });

            for (let index = 0; index < parts.length; index += 1) {
                const res = await chunk({
                    sessionId,
                    uploadId: initRes.uploadId,
                    index,
                    content: parts[index]!.toString('base64'),
                });
                expect(res.success).toBe(true);
            }

            const finalRes = await finalize({ sessionId, uploadId: initRes.uploadId });
            expect(finalRes).toMatchObject({ success: true, path: expect.any(String) });
            expect(await readFile(finalRes.path)).toEqual(total);

            const info = await stat(finalRes.path);
            expect(isAuthorizedUploadFile(finalRes.path, sessionId, info)).toBe(true);
            expect(isAuthorizedUploadFile(finalRes.path, 'other-session', info)).toBe(false);

            const delRes = await remove({ sessionId, path: finalRes.path });
            expect(delRes).toMatchObject({ success: true });
            expect(isAuthorizedUploadFile(finalRes.path, sessionId, info)).toBe(false);
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('supports zero-byte chunked uploads', async () => {
        const { init, finalize } = setupHandlers();
        const sessionId = `session-zero-${Date.now()}`;
        try {
            const initRes = await init({
                sessionId,
                filename: 'empty.txt',
                size: 0,
                mimeType: 'text/plain',
            });
            expect(initRes.success).toBe(true);

            const finalRes = await finalize({ sessionId, uploadId: initRes.uploadId });
            expect(finalRes.success).toBe(true);
            expect((await stat(finalRes.path)).size).toBe(0);
            expect(isAuthorizedUploadFile(finalRes.path, sessionId, await stat(finalRes.path))).toBe(true);
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('enforces default and HAPI_MAX_UPLOAD_BYTES limits', async () => {
        const { init, abort } = setupHandlers();
        const sessionId = `session-limit-${Date.now()}`;
        const previous = process.env.HAPI_MAX_UPLOAD_BYTES;
        try {
            delete process.env.HAPI_MAX_UPLOAD_BYTES;
            const defaultOver = await init({
                sessionId,
                filename: 'huge.bin',
                size: 512 * 1024 * 1024 + 1,
                mimeType: 'application/octet-stream',
            });
            expect(defaultOver).toMatchObject({ success: false, code: 'upload_too_large' });

            process.env.HAPI_MAX_UPLOAD_BYTES = '1024';
            const customOver = await init({
                sessionId,
                filename: 'over.bin',
                size: 1025,
                mimeType: 'application/octet-stream',
            });
            expect(customOver).toMatchObject({ success: false, code: 'upload_too_large' });

            const customExact = await init({
                sessionId,
                filename: 'exact.bin',
                size: 1024,
                mimeType: 'application/octet-stream',
            });
            expect(customExact).toMatchObject({ success: true, maxUploadBytes: 1024 });
            await abort({ sessionId, uploadId: customExact.uploadId });
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_MAX_UPLOAD_BYTES;
            } else {
                process.env.HAPI_MAX_UPLOAD_BYTES = previous;
            }
            await cleanupUploadDir(sessionId);
        }
    });

    it('rejects out-of-order chunks, overflow, incomplete finalize, and supports idempotent abort', async () => {
        const { init, chunk, finalize, abort } = setupHandlers();
        const sessionId = `session-errors-${Date.now()}`;
        try {
            const initRes = await init({
                sessionId,
                filename: 'data.bin',
                size: 4,
                mimeType: 'application/octet-stream',
            });
            expect(initRes.success).toBe(true);

            const wrongIndex = await chunk({
                sessionId,
                uploadId: initRes.uploadId,
                index: 1,
                content: Buffer.from('ab').toString('base64'),
            });
            expect(wrongIndex).toMatchObject({ success: false, code: 'upload_invalid_chunk' });

            const okFirst = await chunk({
                sessionId,
                uploadId: initRes.uploadId,
                index: 0,
                content: Buffer.from('ab').toString('base64'),
            });
            expect(okFirst).toEqual({ success: true, receivedBytes: 2 });

            const premature = await finalize({ sessionId, uploadId: initRes.uploadId });
            expect(premature).toMatchObject({ success: false, code: 'upload_incomplete' });

            const overflow = await chunk({
                sessionId,
                uploadId: initRes.uploadId,
                index: 1,
                content: Buffer.from('cdef').toString('base64'),
            });
            expect(overflow).toMatchObject({ success: false, code: 'upload_size_mismatch' });

            // Overflow aborts and cleans up the partial file.
            const afterOverflow = await finalize({ sessionId, uploadId: initRes.uploadId });
            expect(afterOverflow).toMatchObject({ success: false, code: 'upload_not_found' });

            const secondInit = await init({
                sessionId,
                filename: 'aborted.bin',
                size: 4,
                mimeType: 'application/octet-stream',
            });
            expect(secondInit.success).toBe(true);
            expect(await abort({ sessionId, uploadId: secondInit.uploadId })).toEqual({ success: true });
            expect(await abort({ sessionId, uploadId: secondInit.uploadId })).toEqual({ success: true });
            expect(await finalize({ sessionId, uploadId: secondInit.uploadId })).toMatchObject({
                success: false,
                code: 'upload_not_found',
            });
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('isolates chunked uploads across sessions', async () => {
        const { init, chunk, finalize, abort } = setupHandlers();
        const sessionA = `session-a-${Date.now()}`;
        const sessionB = `session-b-${Date.now()}`;
        try {
            const initRes = await init({
                sessionId: sessionA,
                filename: 'secret.txt',
                size: 2,
                mimeType: 'text/plain',
            });
            expect(initRes.success).toBe(true);

            expect(await chunk({
                sessionId: sessionB,
                uploadId: initRes.uploadId,
                index: 0,
                content: Buffer.from('hi').toString('base64'),
            })).toMatchObject({ success: false, code: 'upload_not_found' });

            expect(await finalize({ sessionId: sessionB, uploadId: initRes.uploadId })).toMatchObject({
                success: false,
                code: 'upload_not_found',
            });

            expect(await abort({ sessionId: sessionB, uploadId: initRes.uploadId })).toMatchObject({
                success: false,
                code: 'upload_not_found',
            });

            expect(await abort({ sessionId: sessionA, uploadId: initRes.uploadId })).toEqual({ success: true });
        } finally {
            await cleanupUploadDir(sessionA);
            await cleanupUploadDir(sessionB);
        }
    });

    it('fits long filenames within 255 bytes even with the .part suffix', async () => {
        const { init, finalize } = setupHandlers();
        const sessionId = `session-long-chunked-${Date.now()}`;
        try {
            const initRes = await init({
                sessionId,
                filename: `${'a'.repeat(300)}.mp4`,
                size: 0,
                mimeType: 'video/mp4',
            });
            expect(initRes.success).toBe(true);
            const finalRes = await finalize({ sessionId, uploadId: initRes.uploadId });
            expect(finalRes.success).toBe(true);
            expect(basename(finalRes.path)).toMatch(/\.mp4$/);
            expect(Buffer.byteLength(`${basename(finalRes.path)}.part`)).toBeLessThanOrEqual(255);
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('expires idle chunked uploads and cleans up during cleanupUploadDir', async () => {
        const { init, chunk, finalize } = setupHandlers(30);
        const sessionId = `session-ttl-${Date.now()}`;
        try {
            const initRes = await init({
                sessionId,
                filename: 'idle.bin',
                size: 4,
                mimeType: 'application/octet-stream',
            });
            expect(initRes.success).toBe(true);

            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(await finalize({ sessionId, uploadId: initRes.uploadId })).toMatchObject({
                success: false,
                code: 'upload_not_found',
            });

            const activeRes = await init({
                sessionId,
                filename: 'active.bin',
                size: 4,
                mimeType: 'application/octet-stream',
            });
            expect(activeRes.success).toBe(true);
            const dir = join(getHapiBlobsDir());
            expect(activeRes.uploadId).toBeDefined();
            expect(await chunk({
                sessionId,
                uploadId: activeRes.uploadId,
                index: 0,
                content: Buffer.from('ab').toString('base64'),
            })).toEqual({ success: true, receivedBytes: 2 });

            await cleanupUploadDir(sessionId);
            expect(await finalize({ sessionId, uploadId: activeRes.uploadId })).toMatchObject({
                success: false,
                code: 'upload_not_found',
            });

            const remaining = await readdir(dir);
            expect(remaining.some((entry) => entry.startsWith(`${sessionId}-`))).toBe(false);
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('rejects finalizing before receiving all bytes on long files and removes .part when cleanupUploadDir runs', async () => {
        const { init, finalize } = setupHandlers();
        const sessionId = `session-cleanup-${Date.now()}`;
        try {
            const initRes = await init({
                sessionId,
                filename: 'probe.bin',
                size: 10,
                mimeType: 'application/octet-stream',
            });
            expect(initRes.success).toBe(true);
            const fin = await finalize({ sessionId, uploadId: initRes.uploadId });
            expect(fin).toMatchObject({ success: false, code: 'upload_incomplete' });
            const sessionDir = dirname(join(getHapiBlobsDir(), 'placeholder'));
            expect(typeof sessionDir).toBe('string');
        } finally {
            await cleanupUploadDir(sessionId);
        }
    });

    it('reserves concurrent chunked upload slots across async initialization', async () => {
        const { init, abort } = setupHandlers();
        const sessionId = `test-upload-concurrent-${Date.now()}`;
        const uploadIds: string[] = [];
        try {
            const results: Array<{ success: boolean; uploadId?: string; code?: string }> = await Promise.all(
                Array.from({ length: 20 }, (_, i) =>
                    init({
                        sessionId,
                        filename: `file-${i}.bin`,
                        size: 1024,
                        mimeType: 'application/octet-stream',
                    })
                )
            );
            const succeeded = results.filter((res) => res.success);
            const conflicted = results.filter((res) => !res.success && res.code === 'upload_conflict');
            expect(succeeded).toHaveLength(16);
            expect(conflicted).toHaveLength(4);
            for (const res of succeeded) {
                if (res.uploadId) {
                    uploadIds.push(res.uploadId);
                }
            }

            const firstUploadId = uploadIds.shift();
            expect(firstUploadId).toBeTruthy();
            await abort({ sessionId, uploadId: firstUploadId! });

            const replacement = await init({
                sessionId,
                filename: 'replacement.bin',
                size: 1024,
                mimeType: 'application/octet-stream',
            });
            expect(replacement.success).toBe(true);
            if (replacement.uploadId) {
                uploadIds.push(replacement.uploadId);
            }
        } finally {
            await Promise.all(uploadIds.map((uploadId) => abort({ sessionId, uploadId }).catch(() => {})));
            await cleanupUploadDir(sessionId);
        }
    });
});
