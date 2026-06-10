import { describe, expect, it } from 'vitest';
import { ensureLoopbackProxyBypass } from './proxyEnv';

describe('ensureLoopbackProxyBypass', () => {
    it('adds loopback hosts when NO_PROXY is unset', () => {
        const env: NodeJS.ProcessEnv = {};
        ensureLoopbackProxyBypass(env);
        expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
        expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
    });

    it('preserves existing entries and appends missing loopback hosts', () => {
        const env: NodeJS.ProcessEnv = { NO_PROXY: 'npmjs.org' };
        ensureLoopbackProxyBypass(env);
        expect(env.NO_PROXY).toBe('npmjs.org,localhost,127.0.0.1,::1');
    });

    it('does not duplicate already-present hosts', () => {
        const env: NodeJS.ProcessEnv = { NO_PROXY: 'LOCALHOST, 127.0.0.1' };
        ensureLoopbackProxyBypass(env);
        expect(env.NO_PROXY).toBe('LOCALHOST,127.0.0.1,::1');
    });

    it('reads lowercase no_proxy when NO_PROXY is unset', () => {
        const env: NodeJS.ProcessEnv = { no_proxy: 'example.com,localhost,127.0.0.1,::1' };
        ensureLoopbackProxyBypass(env);
        expect(env.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1');
    });

    it('leaves a wildcard NO_PROXY untouched', () => {
        const env: NodeJS.ProcessEnv = { NO_PROXY: '*' };
        ensureLoopbackProxyBypass(env);
        expect(env.NO_PROXY).toBe('*');
        expect(env.no_proxy).toBeUndefined();
    });
});
