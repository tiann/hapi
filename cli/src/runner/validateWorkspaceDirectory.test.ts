import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    describeMkdirError,
    validateWorkspaceDirectory,
} from './validateWorkspaceDirectory';

let workRoot: string;

beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'hapi-validate-workspace-'));
});

afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
});

describe('validateWorkspaceDirectory', () => {
    it('creates a missing directory when approved', async () => {
        const target = join(workRoot, 'new-workspace');
        const result = await validateWorkspaceDirectory(target, {
            approvedNewDirectoryCreation: true,
        });
        expect(result).toEqual({ type: 'ok', created: true });
    });

    it('requests approval when path is missing and creation is not approved', async () => {
        const target = join(workRoot, 'unapproved');
        const result = await validateWorkspaceDirectory(target, {
            approvedNewDirectoryCreation: false,
        });
        expect(result).toEqual({ type: 'requestApproval' });
    });

    it('returns ok without creating when path is already a directory', async () => {
        const target = join(workRoot, 'existing-dir');
        await mkdir(target);
        const result = await validateWorkspaceDirectory(target, {
            approvedNewDirectoryCreation: true,
        });
        expect(result).toEqual({ type: 'ok', created: false });
    });

    it('returns an error when path is a regular file', async () => {
        const target = join(workRoot, 'collision-file');
        await writeFile(target, 'hello');
        const result = await validateWorkspaceDirectory(target, {
            approvedNewDirectoryCreation: true,
        });
        expect(result.type).toBe('error');
        if (result.type === 'error') {
            expect(result.errorMessage).toContain('non-directory file');
            expect(result.errorMessage).toContain(target);
        }
    });

    it('preserves the ENOTDIR diagnostic when the parent path is a regular file', async () => {
        const parentFile = join(workRoot, 'parent-file');
        await writeFile(parentFile, 'hello');
        const target = join(parentFile, 'child-dir');
        const result = await validateWorkspaceDirectory(target, {
            approvedNewDirectoryCreation: true,
        });
        expect(result.type).toBe('error');
        if (result.type === 'error') {
            expect(result.errorMessage).toContain(target);
            expect(result.errorMessage).toMatch(/file already exists/i);
            expect(result.errorMessage).not.toMatch(/Unable to inspect workspace path/);
        }
    });

    it('returns ok when path is a symlink to an existing directory', async () => {
        const realTarget = join(workRoot, 'real-target');
        await mkdir(realTarget);
        const link = join(workRoot, 'good-symlink');
        await symlink(realTarget, link);

        const result = await validateWorkspaceDirectory(link, {
            approvedNewDirectoryCreation: true,
        });
        expect(result).toEqual({ type: 'ok', created: false });
    });

    it('returns a diagnostic error when path is a dangling symlink', async () => {
        const missingTarget = join(workRoot, 'gone-target');
        const link = join(workRoot, 'dangling-symlink');
        await symlink(missingTarget, link);
        // missingTarget is never created, so the link is dangling.

        const result = await validateWorkspaceDirectory(link, {
            approvedNewDirectoryCreation: true,
        });
        expect(result.type).toBe('error');
        if (result.type === 'error') {
            expect(result.errorMessage).toContain(link);
            expect(result.errorMessage).toContain(missingTarget);
            expect(result.errorMessage).toMatch(/symbolic link/i);
            expect(result.errorMessage).toMatch(/no longer exists/i);
            expect(result.errorMessage).toMatch(/Recovery:/);
            expect(result.errorMessage).not.toMatch(/EEXIST/);
            // Regression: must not embed the user-controlled path inside a
            // copy-pasteable shell command (`rm '...'`) - a path with a
            // single quote would break the quoting and create an injection
            // / accidental-delete vector. (Codex review on PR #892.)
            expect(result.errorMessage).not.toMatch(/`rm /);
        }
    });

    it('does not produce a copy-pasteable rm command when the path contains a single quote', async () => {
        // Regression for the PR #892 Codex review Major: paths with
        // single quotes used to break out of the literal `rm '...'`
        // recovery hint and turn the diagnostic into a shell-injection
        // / accidental-delete vector.
        const trickyDir = join(workRoot, "weird'name");
        await mkdir(trickyDir);
        const missingTarget = join(trickyDir, 'gone-target');
        const link = join(trickyDir, 'dangling-symlink');
        await symlink(missingTarget, link);

        const result = await validateWorkspaceDirectory(link, {
            approvedNewDirectoryCreation: true,
        });
        expect(result.type).toBe('error');
        if (result.type === 'error') {
            expect(result.errorMessage).toContain(link);
            expect(result.errorMessage).toContain(missingTarget);
            expect(result.errorMessage).not.toMatch(/`rm /);
        }
    });

    it('returns an error when path is a symlink to a non-directory', async () => {
        const targetFile = join(workRoot, 'target-file');
        await writeFile(targetFile, 'hello');
        const link = join(workRoot, 'symlink-to-file');
        await symlink(targetFile, link);

        const result = await validateWorkspaceDirectory(link, {
            approvedNewDirectoryCreation: true,
        });
        expect(result.type).toBe('error');
        if (result.type === 'error') {
            expect(result.errorMessage).toContain(link);
            expect(result.errorMessage).toContain(targetFile);
            expect(result.errorMessage).toMatch(/not a directory/i);
        }
    });
});

describe('describeMkdirError', () => {
    const directory = '/tmp/hapi-test-target';

    it('produces a Permission denied message for EACCES', () => {
        const msg = describeMkdirError(directory, {
            code: 'EACCES',
            message: 'permission denied',
        });
        expect(msg).toContain(directory);
        expect(msg).toContain('Permission denied');
    });

    it('produces an ENOTDIR message for ENOTDIR', () => {
        const msg = describeMkdirError(directory, {
            code: 'ENOTDIR',
            message: 'not a directory',
        });
        expect(msg).toContain(directory);
        expect(msg).toMatch(/file already exists/i);
    });

    it('produces a No space left on device message for ENOSPC', () => {
        const msg = describeMkdirError(directory, {
            code: 'ENOSPC',
            message: 'no space left on device',
        });
        expect(msg).toContain(directory);
        expect(msg).toMatch(/No space left on device/i);
    });

    it('produces a read-only file system message for EROFS', () => {
        const msg = describeMkdirError(directory, {
            code: 'EROFS',
            message: 'read-only file system',
        });
        expect(msg).toContain(directory);
        expect(msg).toMatch(/read-only/i);
    });

    it('produces a non-directory race message for EEXIST', () => {
        const msg = describeMkdirError(directory, {
            code: 'EEXIST',
            message: 'file already exists',
        });
        expect(msg).toContain(directory);
        expect(msg).toMatch(/non-directory file/i);
        expect(msg).not.toMatch(/EEXIST/);
    });

    it('falls back to System error for unknown codes', () => {
        const msg = describeMkdirError(directory, {
            code: 'EWEIRD',
            message: 'something strange',
        });
        expect(msg).toContain(directory);
        expect(msg).toContain('System error: something strange');
    });
});
