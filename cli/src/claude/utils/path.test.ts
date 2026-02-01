import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getProjectPath } from './path';
import { join } from 'node:path';

vi.mock('node:os', () => ({
    homedir: vi.fn(() => '/home/user')
}));

// Store original env
const originalEnv = process.env;

describe('getProjectPath', () => {
    beforeEach(() => {
        // Reset process.env to a clean state
        process.env = { ...originalEnv };
        delete process.env.CLAUDE_CONFIG_DIR;
    });

    afterEach(() => {
        // Restore original env
        process.env = originalEnv;
    });
    it('should replace slashes with hyphens in the project path', () => {
        const workingDir = '/Users/steve/projects/my-app';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/home/user', '.claude', 'projects', '-Users-steve-projects-my-app'));
    });

    it('should replace dots with hyphens in the project path', () => {
        const workingDir = '/Users/steve/projects/app.test.js';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/home/user', '.claude', 'projects', '-Users-steve-projects-app-test-js'));
    });

    it('should handle paths with both slashes and dots', () => {
        const workingDir = '/var/www/my.site.com/public';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/home/user', '.claude', 'projects', '-var-www-my-site-com-public'));
    });

    it('should replace underscores with hyphens in the project path', () => {
        const workingDir = '/data/github/hapi__worktrees/ime';
        const result = getProjectPath(workingDir);
        expect(result).toBe(join('/home/user', '.claude', 'projects', '-data-github-hapi--worktrees-ime'));
    });

    it('should handle relative paths by resolving them first', () => {
        const workingDir = './my-project';
        const result = getProjectPath(workingDir);
        expect(result).toContain(join('/home/user', '.claude', 'projects'));
        expect(result).toContain('my-project');
    });

    it('should handle empty directory path', () => {
        const workingDir = '';
        const result = getProjectPath(workingDir);
        expect(result).toContain(join('/home/user', '.claude', 'projects'));
    });

    describe('CLAUDE_CONFIG_DIR support', () => {
        it('should use default .claude directory when CLAUDE_CONFIG_DIR is not set', () => {
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/home/user', '.claude', 'projects', '-Users-steve-projects-my-app'));
        });

        it('should use CLAUDE_CONFIG_DIR when set', () => {
            process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/custom/claude/config', 'projects', '-Users-steve-projects-my-app'));
        });

        it('should handle relative CLAUDE_CONFIG_DIR path', () => {
            process.env.CLAUDE_CONFIG_DIR = './config/claude';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('./config/claude', 'projects', '-Users-steve-projects-my-app'));
        });

        it('should fallback to default when CLAUDE_CONFIG_DIR is empty string', () => {
            process.env.CLAUDE_CONFIG_DIR = '';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/home/user', '.claude', 'projects', '-Users-steve-projects-my-app'));
        });

        it('should handle CLAUDE_CONFIG_DIR with trailing slash', () => {
            process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config/';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(join('/custom/claude/config/', 'projects', '-Users-steve-projects-my-app'));
        });
    });

    // Windows-specific tests
    if (process.platform === 'win32') {
        describe('Windows compatibility', () => {
            it('should preserve drive letter and remove colon from Windows paths', () => {
                const workingDir = 'D:\\MyTools\\hapi';
                const result = getProjectPath(workingDir);
                const projectId = result.split('\\').pop();
                // D:\MyTools\hapi → D\MyTools\hapi → D-MyTools-hapi
                expect(projectId).toBe('D-MyTools-hapi');
            });

            it('should distinguish between different drives', () => {
                const pathD = getProjectPath('D:\\MyTools\\hapi');
                const pathC = getProjectPath('C:\\MyTools\\hapi');
                const projectIdD = pathD.split('\\').pop();
                const projectIdC = pathC.split('\\').pop();

                // Different drives should produce different project IDs
                expect(projectIdD).toBe('D-MyTools-hapi');
                expect(projectIdC).toBe('C-MyTools-hapi');
                expect(projectIdD).not.toBe(projectIdC);
            });

            it('should handle Windows paths with drive letter correctly', () => {
                const workingDir = 'C:\\Users\\steve\\projects\\my-app';
                const result = getProjectPath(workingDir);
                const projectId = result.split('\\').pop();
                expect(projectId).toBe('C-Users-steve-projects-my-app');
            });
        });
    }
});