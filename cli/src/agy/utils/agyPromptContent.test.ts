import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentMetadata } from '@/api/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';

const authState = vi.hoisted(() => ({
    withinUploadDir: true,
    authorized: true
}));

vi.mock('@/modules/common/handlers/uploads', () => ({
    isPathWithinUploadDir: () => authState.withinUploadDir,
    isAuthorizedUploadFile: () => authState.authorized
}));

import {
    agyImageAttachmentsFor,
    buildAgyPromptContent,
    formatAgyUserMessage,
    isAgyInlineImageAttachment
} from './agyPromptContent';

function fakeBackend(imagePrompts: boolean): AcpSdkBackend {
    return { supportsImagePrompts: () => imagePrompts } as unknown as AcpSdkBackend;
}

function attachment(partial: Partial<AttachmentMetadata> & { path: string; mimeType: string }): AttachmentMetadata {
    return {
        id: 'attachment-1',
        filename: 'file',
        size: 10,
        ...partial
    };
}

describe('isAgyInlineImageAttachment', () => {
    it('accepts canonical inline image mime types (case-insensitive)', () => {
        for (const mimeType of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
            expect(isAgyInlineImageAttachment(attachment({ path: '/uploads/a', mimeType }))).toBe(true);
        }
    });

    it('rejects non-inline attachments', () => {
        for (const mimeType of ['text/plain', 'application/pdf', 'image/heic', '']) {
            expect(isAgyInlineImageAttachment(attachment({ path: '/uploads/a', mimeType }))).toBe(false);
        }
    });
});

describe('formatAgyUserMessage', () => {
    it('keeps non-image attachments as @path references and drops inline images', () => {
        expect(formatAgyUserMessage('hello', [
            attachment({ path: '/uploads/shot.png', mimeType: 'image/png' }),
            attachment({ path: '/uploads/notes.txt', mimeType: 'text/plain' })
        ])).toBe('@/uploads/notes.txt\n\nhello');
    });

    it('keeps non-canonical images in text form', () => {
        expect(formatAgyUserMessage('hello', [
            attachment({ path: '/uploads/photo.heic', mimeType: 'image/heic' })
        ])).toBe('@/uploads/photo.heic\n\nhello');
    });

    it('returns bare text when no non-image attachments exist', () => {
        expect(formatAgyUserMessage('hello', undefined)).toBe('hello');
        expect(formatAgyUserMessage('hello', [])).toBe('hello');
    });
});

describe('agyImageAttachmentsFor', () => {
    it('collects only inline-capable images', () => {
        expect(agyImageAttachmentsFor([
            attachment({ path: '/uploads/a.png', mimeType: 'image/png', filename: 'a.png' }),
            attachment({ path: '/uploads/b.pdf', mimeType: 'application/pdf' }),
            attachment({ path: '/uploads/c.webp', mimeType: 'image/webp' })
        ])).toEqual({
            imageAttachments: [
                { path: '/uploads/a.png', mimeType: 'image/png', filename: 'a.png' },
                { path: '/uploads/c.webp', mimeType: 'image/webp', filename: 'file' }
            ]
        });
    });

    it('omits the field without inline images', () => {
        expect(agyImageAttachmentsFor(undefined)).toEqual({});
        expect(agyImageAttachmentsFor([
            attachment({ path: '/uploads/b.pdf', mimeType: 'application/pdf' })
        ])).toEqual({});
    });
});

describe('buildAgyPromptContent', () => {
    let uploadDir: string;

    beforeEach(async () => {
        authState.withinUploadDir = true;
        authState.authorized = true;
        uploadDir = await mkdtemp(join(tmpdir(), 'agy-prompt-'));
    });

    afterEach(async () => {
        await rm(uploadDir, { recursive: true, force: true });
    });

    it('returns a plain text block without image attachments', async () => {
        const prompt = await buildAgyPromptContent(fakeBackend(true), 'hello', undefined, {
            sessionId: 'session-1',
            onNotice: () => {}
        });
        expect(prompt).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('falls back to @path text form when backend does not advertise image prompts', async () => {
        const prompt = await buildAgyPromptContent(fakeBackend(false), 'hello', [
            { path: '/uploads/a.png', mimeType: 'image/png' }
        ], { sessionId: 'session-1', onNotice: () => {} });
        expect(prompt).toEqual([{ type: 'text', text: '@/uploads/a.png\n\nhello' }]);
    });

    it('reads authorized image files into base64 image blocks and normalizes image/jpg', async () => {
        const pngPath = join(uploadDir, 'shot.png');
        const jpgPath = join(uploadDir, 'photo.jpg');
        await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await writeFile(jpgPath, Buffer.from('jpg'));

        const prompt = await buildAgyPromptContent(fakeBackend(true), 'look', [
            { path: pngPath, mimeType: 'image/png', filename: 'shot.png' },
            { path: jpgPath, mimeType: 'image/jpg' }
        ], { sessionId: 'session-1', onNotice: () => {} });

        expect(prompt).toEqual([
            { type: 'text', text: 'look' },
            { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' },
            { type: 'image', data: Buffer.from('jpg').toString('base64'), mimeType: 'image/jpeg' }
        ]);
    });

    it('notifies and skips unauthorized or missing images without failing the turn', async () => {
        authState.withinUploadDir = false;
        const notices: string[] = [];

        const prompt = await buildAgyPromptContent(fakeBackend(true), 'look', [
            { path: '/elsewhere/shot.png', mimeType: 'image/png', filename: 'shot.png' }
        ], { sessionId: 'session-1', onNotice: (message) => notices.push(message) });

        expect(prompt).toEqual([{ type: 'text', text: 'look' }]);
        expect(notices).toEqual(['Could not attach image shot.png: invalid upload path']);
    });

    it('strips encoded @imagePath refs from queued text while keeping captions, non-image refs, and unreadable @imagePath refs', async () => {
        const pngPath = join(uploadDir, 'shot 1.png');
        await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        const captioned = await buildAgyPromptContent(
            fakeBackend(true),
            `@${pngPath} @/uploads/notes.txt\n\ncheck this`,
            [{ path: pngPath, mimeType: 'image/png', filename: 'shot 1.png' }],
            { sessionId: 'session-1', onNotice: () => {} }
        );
        expect(captioned).toEqual([
            { type: 'text', text: '@/uploads/notes.txt\n\ncheck this' },
            { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' }
        ]);

        const imageOnly = await buildAgyPromptContent(
            fakeBackend(true),
            `@${pngPath}`,
            [{ path: pngPath, mimeType: 'image/png', filename: 'shot 1.png' }],
            { sessionId: 'session-1', onNotice: () => {} }
        );
        expect(imageOnly).toEqual([
            { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' }
        ]);

        authState.withinUploadDir = false;
        const unreadableFallback = await buildAgyPromptContent(
            fakeBackend(true),
            `@${pngPath}`,
            [{ path: pngPath, mimeType: 'image/png', filename: 'shot 1.png' }],
            { sessionId: 'session-1', onNotice: () => {} }
        );
        expect(unreadableFallback).toEqual([{ type: 'text', text: `@${pngPath}` }]);
    });

    it('avoids duplicating @path when !supportsImagePrompts() receives queued attachment text', async () => {
        const prompt = await buildAgyPromptContent(
            fakeBackend(false),
            '@/uploads/a.png @/uploads/notes.txt\n\nhello',
            [{ path: '/uploads/a.png', mimeType: 'image/png' }],
            { sessionId: 'session-1', onNotice: () => {} }
        );
        expect(prompt).toEqual([{ type: 'text', text: '@/uploads/a.png @/uploads/notes.txt\n\nhello' }]);

        const imageOnly = await buildAgyPromptContent(
            fakeBackend(false),
            '@/uploads/a.png',
            [{ path: '/uploads/a.png', mimeType: 'image/png' }],
            { sessionId: 'session-1', onNotice: () => {} }
        );
        expect(imageOnly).toEqual([{ type: 'text', text: '@/uploads/a.png' }]);
    });
});
