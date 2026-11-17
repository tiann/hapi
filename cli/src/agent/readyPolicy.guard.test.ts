import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(import.meta.dirname, '..');
// Platform separators on both sides: relative() returns backslashes on Windows.
const policySource = join('agent', 'readyPolicy.ts');
// Regression tripwire: catches the literal sendSessionEvent({ type: 'ready' })
// form outside the policy. Novel indirections (prebuilt event objects, helper
// wrappers) stay review concerns rather than covered shapes.
const directReadyEvent = /sendSessionEvent\s*\(\s*\{\s*type\s*:\s*['"]ready['"]/;

async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    }));
    return files.flat();
}

describe('ready event policy boundary', () => {
    it('regression tripwire: no literal ready emits outside the shared policy', async () => {
        const offenders: string[] = [];
        for (const file of await sourceFiles(sourceRoot)) {
            const path = relative(sourceRoot, file);
            if (path === policySource || !directReadyEvent.test(await readFile(file, 'utf8'))) continue;
            offenders.push(path);
        }
        expect(offenders).toEqual([]);
    });
});
