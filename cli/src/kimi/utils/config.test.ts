import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveKimiRuntimeConfig } from './config';

describe('resolveKimiRuntimeConfig', () => {
    let homeDir: string;
    let previousHome: string | undefined;

    beforeEach(async () => {
        previousHome = process.env.KIMI_CODE_HOME;
        homeDir = join(tmpdir(), `kimi-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(homeDir, { recursive: true });
        process.env.KIMI_CODE_HOME = homeDir;
    });

    afterEach(async () => {
        if (previousHome === undefined) {
            delete process.env.KIMI_CODE_HOME;
        } else {
            process.env.KIMI_CODE_HOME = previousHome;
        }
        if (existsSync(homeDir)) {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('prefers the explicit model', async () => {
        await writeFile(join(homeDir, 'config.toml'), 'default_model = "kimi-code/k3"\n');
        expect(resolveKimiRuntimeConfig({ model: 'explicit-model' })).toEqual({
            model: 'explicit-model',
            modelSource: 'explicit'
        });
    });

    it('reads default_model from the new kimi-code home', async () => {
        await writeFile(join(homeDir, 'config.toml'), 'default_model = "kimi-code/k3"\n');
        expect(resolveKimiRuntimeConfig()).toEqual({
            model: 'kimi-code/k3',
            modelSource: 'local'
        });
    });

    it('returns no model when nothing is configured (no hardcoded fallback)', () => {
        expect(resolveKimiRuntimeConfig()).toEqual({
            model: undefined,
            modelSource: 'default'
        });
    });
});
