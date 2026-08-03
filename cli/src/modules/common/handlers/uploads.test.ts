import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getHapiBlobsDir } from '@/constants/uploadPaths';
import { isPathWithinUploadDir } from './uploads';

describe('isPathWithinUploadDir', () => {
    it('accepts only paths under the matching session upload directory', () => {
        const sessionId = 'session-allowed';
        const ownUpload = join(getHapiBlobsDir(), `${sessionId}-random`, 'image.png');
        const otherUpload = join(getHapiBlobsDir(), 'session-other-random', 'image.png');

        expect(isPathWithinUploadDir(ownUpload, sessionId)).toBe(true);
        expect(isPathWithinUploadDir(otherUpload, sessionId)).toBe(false);
        expect(isPathWithinUploadDir('/etc/hosts', sessionId)).toBe(false);
    });
});
