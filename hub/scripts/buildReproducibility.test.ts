import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bunVersion = '1.3.11';
const workflows = ['test.yml', 'webapp.yml', 'release.yml'];

describe('build toolchain reproducibility', () => {
    it('pins one Bun package manager version at the workspace and published CLI roots', async () => {
        for (const relativePath of ['package.json', join('cli', 'package.json')]) {
            const packageJson = JSON.parse(await readFile(join(root, relativePath), 'utf8')) as {
                packageManager?: string;
            };
            expect(packageJson.packageManager).toBe(`bun@${bunVersion}`);
        }
    });

    it('pins Bun and frozen lockfile installs in every build workflow', async () => {
        for (const workflow of workflows) {
            const contents = await readFile(join(root, '.github', 'workflows', workflow), 'utf8');
            expect(contents).toMatch(new RegExp(
                `uses: oven-sh/setup-bun@v2\\n\\s+with:\\n\\s+bun-version: ['\"]?${bunVersion.replaceAll('.', '\\.')}`,
            ));
            expect(contents).not.toMatch(/- run: bun install\s*$/m);
            expect(contents).toMatch(/- run: bun install --frozen-lockfile\s*$/m);
        }
    });

    it('keeps build helper scripts inside the Hub strict typecheck gate', async () => {
        const tsconfig = JSON.parse(await readFile(join(root, 'hub', 'tsconfig.json'), 'utf8')) as {
            include?: string[];
        };
        expect(tsconfig.include).toContain('scripts/**/*.ts');
    });
});
