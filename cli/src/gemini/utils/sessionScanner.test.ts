import { describe, expect, it, vi, beforeEach } from 'vitest';
import { findGeminiTranscriptPath, readGeminiTranscript, extractMessageText } from './sessionScanner';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof os>();
    return { ...actual, homedir: vi.fn().mockReturnValue('/tmp/testuser-gemini') };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>();
    return {
        ...actual,
        readdir: vi.fn(),
        readFile: vi.fn()
    };
});

const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);

describe('findGeminiTranscriptPath', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns null when gemini tmp dir does not exist', async () => {
        mockReaddir.mockRejectedValue(new Error('ENOENT'));
        const result = await findGeminiTranscriptPath('8d5d37c2-dce5-460c-b516-94dbc1c197e9');
        expect(result).toBeNull();
    });

    it('finds the session file by the first 8 chars of the session ID', async () => {
        mockReaddir
            .mockResolvedValueOnce(['lupin'] as any)
            .mockResolvedValueOnce([
                'session-2026-03-08T05-31-8d5d37c2.json',
                'session-2026-03-08T06-00-abcdef12.json'
            ] as any);

        const result = await findGeminiTranscriptPath('8d5d37c2-dce5-460c-b516-94dbc1c197e9');
        expect(result).toBe(
            path.join('/tmp/testuser-gemini', '.gemini', 'tmp', 'lupin', 'chats', 'session-2026-03-08T05-31-8d5d37c2.json')
        );
    });

    it('returns null when no matching file exists', async () => {
        mockReaddir
            .mockResolvedValueOnce(['lupin'] as any)
            .mockResolvedValueOnce(['session-2026-03-08T06-00-abcdef12.json'] as any);

        const result = await findGeminiTranscriptPath('8d5d37c2-dce5-460c-b516-94dbc1c197e9');
        expect(result).toBeNull();
    });
});

describe('extractMessageText', () => {
    it('returns string content as-is', () => {
        expect(extractMessageText('hello')).toBe('hello');
    });

    it('returns null for empty string', () => {
        expect(extractMessageText('')).toBeNull();
    });

    it('joins array content parts into a single string', () => {
        expect(extractMessageText([{ text: 'hello' }, { text: ' world' }])).toBe('hello world');
    });

    it('returns null for empty array', () => {
        expect(extractMessageText([])).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(extractMessageText(undefined)).toBeNull();
    });

    it('handles array parts with missing text property', () => {
        expect(extractMessageText([{ text: 'hi' }, {}])).toBe('hi');
    });
});

describe('readGeminiTranscript', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('returns null on read error', async () => {
        mockReadFile.mockRejectedValue(new Error('ENOENT'));
        const result = await readGeminiTranscript('/nonexistent.json');
        expect(result).toBeNull();
    });

    it('parses sessionId and messages from transcript file', async () => {
        const transcript = {
            sessionId: '8d5d37c2-dce5-460c-b516-94dbc1c197e9',
            messages: [
                { id: '1', type: 'user', content: 'hello' },
                { id: '2', type: 'gemini', content: 'hi there' }
            ]
        };
        mockReadFile.mockResolvedValue(JSON.stringify(transcript));
        const result = await readGeminiTranscript('/some/path.json');
        expect(result?.sessionId).toBe('8d5d37c2-dce5-460c-b516-94dbc1c197e9');
        expect(result?.messages).toHaveLength(2);
    });
});
