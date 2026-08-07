import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexAppServerCommand } from './codexAppServerClient';

const originalAppServerBin = process.env.HAPI_CODEX_APP_SERVER_BIN;
const originalCodexProfile = process.env.HAPI_CODEX_PROFILE;

afterEach(() => {
    if (originalAppServerBin === undefined) {
        delete process.env.HAPI_CODEX_APP_SERVER_BIN;
    } else {
        process.env.HAPI_CODEX_APP_SERVER_BIN = originalAppServerBin;
    }

    if (originalCodexProfile === undefined) {
        delete process.env.HAPI_CODEX_PROFILE;
    } else {
        process.env.HAPI_CODEX_PROFILE = originalCodexProfile;
    }
});

describe('resolveCodexAppServerCommand', () => {
    it('starts app-server without a profile by default', () => {
        process.env.HAPI_CODEX_APP_SERVER_BIN = '/tmp/codex';
        delete process.env.HAPI_CODEX_PROFILE;

        expect(resolveCodexAppServerCommand()).toEqual({
            command: '/tmp/codex',
            args: ['app-server']
        });
    });

    it('starts app-server with the configured Codex profile', () => {
        process.env.HAPI_CODEX_APP_SERVER_BIN = '/tmp/codex';
        process.env.HAPI_CODEX_PROFILE = ' tapsvc ';

        expect(resolveCodexAppServerCommand()).toEqual({
            command: '/tmp/codex',
            args: ['--profile', 'tapsvc', 'app-server']
        });
    });
});
