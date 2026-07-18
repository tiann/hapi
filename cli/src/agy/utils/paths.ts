import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getHapiBlobsDir } from '@/constants/uploadPaths';

function addUniqueDirectory(result: string[], seen: Set<string>, value: string | undefined, cwd: string): void {
    const trimmed = value?.trim();
    if (!trimmed) {
        return;
    }
    const resolvedCwd = resolve(cwd);
    const resolved = resolve(resolvedCwd, trimmed);
    if (resolved === resolvedCwd || seen.has(resolved)) {
        return;
    }
    seen.add(resolved);
    result.push(resolved);
}

export function buildAgyAdditionalDirectories(opts: {
    cwd: string;
    additionalDirectories?: readonly string[];
}): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    const blobsDir = getHapiBlobsDir();
    mkdirSync(blobsDir, { recursive: true });
    addUniqueDirectory(result, seen, blobsDir, opts.cwd);

    addUniqueDirectory(result, seen, process.env.HAPI_WORKTREE_BASE_PATH, opts.cwd);
    for (const directory of opts.additionalDirectories ?? []) {
        addUniqueDirectory(result, seen, directory, opts.cwd);
    }
    return result;
}

export function resolveAgyLogFile(defaultLogPath: string, override?: string): string {
    const trimmed = override?.trim();
    return trimmed || `${defaultLogPath}.agy.log`;
}
