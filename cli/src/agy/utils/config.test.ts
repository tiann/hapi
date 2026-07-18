import { describe, expect, it } from 'vitest';
import { buildAgyEnv } from './config';

describe('buildAgyEnv', () => {
    it('strips provider auth env while preserving HAPI runtime env and agy settings', () => {
        const env = buildAgyEnv({
            model: 'Gemini 3.5 Flash (High)',
            cwd: '/tmp/project',
            baseEnv: {
                PATH: '/usr/bin:/bin',
                HOME: '/Users/example',
                HAPI_SESSION_ID: 'session-1',
                CODEX_HANDOFF_CALLER_TAG: 'session-1',
                GEMINI_API_KEY: 'bad-gemini-key',
                GOOGLE_API_KEY: 'bad-google-key',
                GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google.json',
                GOOGLE_CLOUD_PROJECT: 'wrong-project',
                OPENAI_API_KEY: 'bad-openai-key',
                ANTHROPIC_API_KEY: 'bad-anthropic-key'
            }
        });

        expect(env).toMatchObject({
            PATH: '/usr/bin:/bin',
            HOME: '/Users/example',
            HAPI_SESSION_ID: 'session-1',
            CODEX_HANDOFF_CALLER_TAG: 'session-1',
            AGY_MODEL: 'Gemini 3.5 Flash (High)',
            AGY_PROJECT_DIR: '/tmp/project'
        });
        expect(env.GEMINI_API_KEY).toBeUndefined();
        expect(env.GOOGLE_API_KEY).toBeUndefined();
        expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
        expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });
});
