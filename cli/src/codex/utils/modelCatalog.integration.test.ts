import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../codexAppServerClient';
import { sharedLaunchConfig } from '../shared/launch';

// Opt-in native check; no credentials, inference calls, or production config changes.
const executable = process.env.HAPI_TEST_CODEX_BIN;
const fixture = process.env.HAPI_TEST_CODEX_CATALOG;
describe.skipIf(!executable || !fixture)('local model catalog with native Codex', () => {
    it.each(['standalone', 'shared-resume', 'configured-standalone'])('loads the configured catalog offline for %s', async mode => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-catalog-native-'));
        const catalog = JSON.parse(readFileSync(fixture!, 'utf8'));
        catalog.models[0].display_name = 'HAPI local catalog probe';
        const path = join(home, 'models_cache.json');
        writeFileSync(path, JSON.stringify(catalog));
        vi.stubEnv('CODEX_HOME', home);
        vi.stubEnv('HAPI_CODEX_MODEL_CATALOG_JSON', mode === 'configured-standalone' ? '' : path);
        if (mode === 'configured-standalone') writeFileSync(join(home, 'config.toml'), `model_catalog_json=${JSON.stringify(path)}\n`);
        vi.stubEnv('HAPI_CODEX_APP_SERVER_BIN', executable!);
        for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
            vi.stubEnv(name, 'http://127.0.0.1:9');
        }
        vi.stubEnv('NO_PROXY', '');
        vi.stubEnv('no_proxy', '');
        try {
            let models: Array<{ displayName?: string }>;
            if (mode !== 'shared-resume') {
                const client = new CodexAppServerClient({ cwd: home });
                try {
                    await client.connect();
                    await client.initialize({ clientInfo: { name: 'hapi-catalog-test', version: '1' }, capabilities: null });
                    models = (await client.listModels()).data ?? [];
                } finally {
                    await client.disconnect();
                }
            } else {
                const launch = sharedLaunchConfig({ resumeSessionId: 'existing-thread' }, home);
                const child = spawn(executable!, ['app-server', ...launch.serverArgs], {
                    cwd: home, env: process.env, stdio: ['pipe', 'pipe', 'pipe']
                });
                const lines = createInterface({ input: child.stdout });
                try {
                    models = await new Promise<Array<{ displayName?: string }>>((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error('Native catalog probe timed out')), 10_000);
                        const finish = () => clearTimeout(timer);
                        child.once('error', error => { finish(); reject(error); });
                        child.once('exit', () => { finish(); reject(new Error('Native Codex exited before model/list')); });
                        lines.on('line', line => {
                            const response = JSON.parse(line);
                            if (response.error) { finish(); reject(new Error(JSON.stringify(response.error))); return; }
                            if (response.id === 1) {
                                child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
                                child.stdin.write(JSON.stringify({ id: 2, method: 'model/list', params: {} }) + '\n');
                            } else if (response.id === 2) {
                                finish(); resolve(response.result.data);
                            }
                        });
                        child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
                            clientInfo: { name: 'hapi-catalog-test', version: '1' }
                        } }) + '\n');
                    });
                } finally {
                    lines.close();
                    child.kill();
                    await new Promise<void>(resolve => {
                        if (child.exitCode !== null || child.signalCode !== null) resolve();
                        else child.once('exit', () => resolve());
                    });
                }
            }
            expect(models).toContainEqual(expect.objectContaining({ displayName: 'HAPI local catalog probe' }));
        } finally {
            vi.unstubAllEnvs();
            rmSync(home, { recursive: true, force: true });
        }
    }, 20_000);
});
