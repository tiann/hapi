import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from './attachmentLimits';
import { readBoundedAttachmentFile } from './attachmentFile';

describe('readBoundedAttachmentFile', () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });

    async function createTemporaryDirectory(): Promise<string> {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-attachment-file-'));
        directories.push(directory);
        return directory;
    }

    it('reads a small regular file', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'image.png');
        await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        await expect(readBoundedAttachmentFile(path)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    it('rejects a directory', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'not-a-file');
        await mkdir(path);

        await expect(readBoundedAttachmentFile(path)).rejects.toThrow('Attachment must be a regular file');
    });

    it('rejects an oversized sparse file before loading it into memory', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'too-large-sparse.png');
        await writeFile(path, '');
        await truncate(path, MAX_UPLOAD_BYTES + 1);

        await expect(readBoundedAttachmentFile(path)).rejects.toThrow('Attachment file too large (max 50MB)');
    });

    it('enforces a caller-provided remaining aggregate budget before reading', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'second-image.png');
        await writeFile(path, Buffer.from([1, 2, 3, 4]));

        await expect(readBoundedAttachmentFile(path, 3)).rejects.toThrow('remaining image budget');
        await expect(readBoundedAttachmentFile(path, 0)).rejects.toThrow('remaining image budget');
    });
});
