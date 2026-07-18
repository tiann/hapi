import { describe, expect, it } from 'vitest';
import { buildAgyAdditionalDirectories, resolveAgyLogFile } from './paths';
import { getHapiBlobsDir } from '@/constants/uploadPaths';
import { resolve } from 'node:path';

describe('agy paths', () => {
    it('resolves relative additional directories against the session cwd and dedupes cwd', () => {
        const cwd = '/tmp/hapi-agy-worktree';
        const result = buildAgyAdditionalDirectories({
            cwd,
            additionalDirectories: ['.', 'subdir', '/tmp/hapi-agy-worktree/subdir']
        });

        expect(result).toContain(resolve(getHapiBlobsDir()));
        expect(result).not.toContain(resolve(cwd));
        expect(result.filter((entry) => entry === '/tmp/hapi-agy-worktree/subdir')).toHaveLength(1);
    });

    it('uses the explicit log file when present and otherwise derives an agy log path', () => {
        expect(resolveAgyLogFile('/tmp/hapi.log', ' /tmp/custom-agy.log ')).toBe('/tmp/custom-agy.log');
        expect(resolveAgyLogFile('/tmp/hapi.log')).toBe('/tmp/hapi.log.agy.log');
    });
});
