import { describe, expect, it } from 'vitest';
import { buildGrokEnv } from './grokEnv';

describe('buildGrokEnv', () => {
    it('keeps only system/runtime and Grok-owned variables', () => {
        expect(buildGrokEnv({
            PATH: '/usr/bin',
            HOME: '/home/user',
            SHELL: '/bin/zsh',
            TMPDIR: '/tmp/user',
            LANG: 'C.UTF-8',
            LC_MESSAGES: 'en_US.UTF-8',
            SYSTEMROOT: 'C:\\Windows',
            PATHEXT: '.EXE;.CMD',
            GROK_HOME: '/home/user/.grok',
            GROK_SANDBOX: 'off',
            XAI_API_KEY: 'grok-provider-key',
            HTTPS_PROXY: 'http://proxy.invalid',
            NO_PROXY: 'localhost',
            CLI_API_TOKEN: 'hapi-control-secret',
            HAPI_EXTRA_HEADERS_JSON: '{"Authorization":"secret"}',
            HAPI_LAUNCH_NONCE: 'managed-secret',
            OPENAI_API_KEY: 'other-provider-secret',
            ANTHROPIC_AUTH_TOKEN: 'other-provider-secret',
            FEISHU_APP_SECRET: 'unrelated-secret',
            CUSTOM_FLAG: 'not-explicitly-required',
            EMPTY: undefined
        })).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/user',
            SHELL: '/bin/zsh',
            TMPDIR: '/tmp/user',
            LANG: 'C.UTF-8',
            LC_MESSAGES: 'en_US.UTF-8',
            SYSTEMROOT: 'C:\\Windows',
            PATHEXT: '.EXE;.CMD',
            GROK_HOME: '/home/user/.grok',
            GROK_SANDBOX: 'off',
            XAI_API_KEY: 'grok-provider-key',
            HTTPS_PROXY: 'http://proxy.invalid',
            NO_PROXY: 'localhost'
        });
    });
});
