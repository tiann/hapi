import { describe, expect, it } from 'vitest';
import { buildAgyLocalArgs } from './agyLocal';

describe('buildAgyLocalArgs', () => {
    it('passes native workspace/log/resume/model args and maps safe-yolo to sandboxed yolo', () => {
        expect(buildAgyLocalArgs({
            additionalDirectories: ['/tmp/hapi-blobs', ' ', '/tmp/extra'],
            logFile: '/tmp/hapi/agy.log',
            sessionId: 'de582684-d186-4170-81ba-982809b4e28a',
            model: 'Gemini 3.5 Flash (High)',
            permissionMode: 'safe-yolo'
        })).toEqual([
            '--add-dir', '/tmp/hapi-blobs',
            '--add-dir', '/tmp/extra',
            '--log-file', '/tmp/hapi/agy.log',
            '--conversation', 'de582684-d186-4170-81ba-982809b4e28a',
            '--model', 'Gemini 3.5 Flash (High)',
            '--sandbox',
            '--dangerously-skip-permissions'
        ]);
    });

    it('does not pass synthetic HAPI agy session ids to native agy', () => {
        expect(buildAgyLocalArgs({
            sessionId: 'agy-synthetic-session',
            permissionMode: 'yolo'
        })).toEqual(['--dangerously-skip-permissions']);
    });

    it('maps read-only and yolo to distinct native agy permissions', () => {
        expect(buildAgyLocalArgs({
            sessionId: null,
            permissionMode: 'read-only'
        })).toEqual(['--sandbox']);

        expect(buildAgyLocalArgs({
            sessionId: null,
            permissionMode: 'yolo'
        })).toEqual(['--dangerously-skip-permissions']);
    });
});
