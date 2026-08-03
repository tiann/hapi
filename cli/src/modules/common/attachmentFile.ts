import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { MAX_UPLOAD_BYTES } from './attachmentLimits';
import type { UploadFileIdentity } from './handlers/uploads';

/**
 * Reads a user attachment through one file handle with the upload byte limit.
 *
 * The caller is responsible for authorizing the attachment path for its
 * session. This helper intentionally validates only that the opened target is
 * a regular file and that its actual bytes fit the shared upload limit; it does
 * not infer ownership from an arbitrary filesystem path.
 */
export async function readBoundedAttachmentFile(
    path: string,
    maxBytes: number = MAX_UPLOAD_BYTES,
    authorizeOpenedFile?: (identity: UploadFileIdentity) => boolean,
): Promise<Buffer> {
    const byteLimit = Math.min(MAX_UPLOAD_BYTES, Math.max(0, Math.floor(maxBytes)));
    if (byteLimit === 0) {
        throw new Error('Attachment exceeds the remaining image budget');
    }
    // The caller passes the exact registered upload path. O_NOFOLLOW closes the
    // final replacement window on POSIX if it is swapped to a symlink
    // before open; Windows falls back to its normal read-only flag.
    const flags = process.platform === 'win32'
        ? 'r'
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags);
    try {
        // fstat and the subsequent read share this handle so a path replacement
        // cannot change the object after its type/size check.
        const stats = await handle.stat();
        if (authorizeOpenedFile && !authorizeOpenedFile(stats)) {
            throw new Error('invalid upload path');
        }
        if (!stats.isFile()) {
            throw new Error('Attachment must be a regular file');
        }
        if (stats.size > byteLimit) {
            throw new Error(byteLimit === MAX_UPLOAD_BYTES
                ? 'Attachment file too large (max 50MB)'
                : 'Attachment exceeds the remaining image budget');
        }

        // Read into one bounded allocation. The extra sentinel byte detects a
        // file that grows after fstat without retaining chunk buffers plus an
        // equally large Buffer.concat copy at the 50 MiB boundary.
        const buffer = Buffer.allocUnsafe(stats.size + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > stats.size) {
            throw new Error('Attachment changed while it was being read');
        }
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}
