import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCodexBaseUrl, resolveUsageCredentials } from './credentials'

describe('usage query credential resolution', () => {
    it('selects the active Codex provider and ignores comments', () => {
        expect(parseCodexBaseUrl(`
            model_provider = "OpenAI" # active provider
            [model_providers.Other]
            base_url = "https://other.example"
            [model_providers.OpenAI]
            base_url = "https://openai.example/v1"
        `)).toBe('https://openai.example/v1')
        expect(parseCodexBaseUrl(`
            model_provider = "Missing"
            [model_providers.Other]
            base_url = "https://other.example"
        `)).toBeNull()
        expect(parseCodexBaseUrl(`
            [model_providers.Other]
            base_url = "https://other.example"
        `)).toBeNull()
        expect(parseCodexBaseUrl(`
            model_provider = "Gateway"
            [profiles.unused]
            model_provider = "Other"
            [model_providers.Gateway]
            base_url = "https://gateway.example"
            [model_providers.Other]
            base_url = "https://other.example"
        `)).toBe('https://gateway.example')
    })

    it('prefers environment credentials and does not read config when they are complete', async () => {
        const result = await resolveUsageCredentials('claude', {
            ANTHROPIC_BASE_URL: 'https://env.example',
            ANTHROPIC_API_KEY: 'env-secret',
            CLAUDE_CONFIG_DIR: join(tmpdir(), 'missing-claude-config')
        })
        expect(result).toMatchObject({
            baseUrl: 'https://env.example',
            apiKey: 'env-secret',
            baseUrlSource: 'environment',
            apiKeySource: 'environment'
        })
    })

    it('prefers the Claude Code OAuth token environment credential', async () => {
        const result = await resolveUsageCredentials('claude', {
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
            ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
            ANTHROPIC_API_KEY: 'api-secret'
        })
        expect(result).toMatchObject({
            apiKey: 'oauth-secret',
            apiKeySource: 'environment'
        })
    })

    it('reads Claude env entries and Codex config files without returning them to callers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-usage-credentials-'))
        try {
            const claudeDir = join(root, 'claude')
            const codexDir = join(root, 'codex')
            await mkdir(claudeDir)
            await mkdir(codexDir)
            await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
                env: {
                    ANTHROPIC_BASE_URL: 'https://claude.example/',
                    ANTHROPIC_AUTH_TOKEN: 'claude-secret'
                }
            }))
            await writeFile(join(codexDir, 'config.toml'), [
                'model_provider = "Gateway"',
                '[model_providers.Gateway]',
                'base_url = "https://codex.example/v1"',
                'env_key = "CODEX_GATEWAY_API_KEY"'
            ].join('\n'))
            await writeFile(join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'unrelated-openai-secret' }))

            const claude = await resolveUsageCredentials('claude', { CLAUDE_CONFIG_DIR: claudeDir })
            expect(claude).toMatchObject({ baseUrl: 'https://claude.example/', apiKey: 'claude-secret', baseUrlSource: 'config', apiKeySource: 'config' })

            const codex = await resolveUsageCredentials('codex', {
                CODEX_HOME: codexDir,
                CODEX_GATEWAY_API_KEY: 'codex-secret',
                OPENAI_API_KEY: 'unrelated-openai-secret',
                OPENAI_BASE_URL: 'https://api.openai.example/v1'
            })
            expect(codex).toMatchObject({ baseUrl: 'https://codex.example/v1', apiKey: 'codex-secret', baseUrlSource: 'config', apiKeySource: 'environment' })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('uses OpenAI credentials only for the OpenAI Codex provider', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-codex-openai-credentials-'))
        try {
            await writeFile(join(root, 'config.toml'), 'model_provider = "openai"\n')
            await writeFile(join(root, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'config-openai-secret' }))
            const resolved = await resolveUsageCredentials('codex', {
                CODEX_HOME: root,
                OPENAI_BASE_URL: 'https://api.openai.example/v1'
            })
            expect(resolved).toMatchObject({
                baseUrl: 'https://api.openai.example/v1',
                apiKey: 'config-openai-secret',
                baseUrlSource: 'environment',
                apiKeySource: 'config'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('reads the active Kimi provider from config.toml and environment overrides', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-kimi-credentials-'))
        try {
            await mkdir(root, { recursive: true })
            await writeFile(join(root, 'config.toml'), [
                'default_model = "kimi-for-coding"',
                '[providers.kimi-for-coding]',
                'type = "kimi"',
                'base_url = "https://api.kimi.com/coding/v1"',
                'api_key = "config-kimi-secret"',
                '[models.kimi-for-coding]',
                'provider = "kimi-for-coding"'
            ].join('\n'))
            const configured = await resolveUsageCredentials('kimi', { KIMI_CODE_HOME: root })
            expect(configured).toMatchObject({
                baseUrl: 'https://api.kimi.com/coding/v1',
                apiKey: 'config-kimi-secret',
                baseUrlSource: 'config',
                apiKeySource: 'config'
            })

            const environment = await resolveUsageCredentials('kimi', {
                KIMI_CODE_HOME: root,
                KIMI_BASE_URL: 'https://env.kimi.example/v1',
                KIMI_API_KEY: 'env-kimi-secret'
            })
            expect(environment).toMatchObject({
                baseUrl: 'https://env.kimi.example/v1',
                apiKey: 'env-kimi-secret',
                baseUrlSource: 'environment',
                apiKeySource: 'environment'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('resolves a provider-qualified Kimi default without a model alias table', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-kimi-qualified-default-'))
        try {
            await writeFile(join(root, 'config.toml'), [
                'default_model = "kimi-code/k3"',
                '[providers.kimi-code]',
                'type = "kimi"',
                'base_url = "https://qualified.kimi.example/coding/v1"',
                'api_key = "qualified-kimi-secret"'
            ].join('\n'))

            const resolved = await resolveUsageCredentials('kimi', { KIMI_CODE_HOME: root })
            expect(resolved).toMatchObject({
                baseUrl: 'https://qualified.kimi.example/coding/v1',
                apiKey: 'qualified-kimi-secret',
                baseUrlSource: 'config',
                apiKeySource: 'config'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('prefers the current Kimi Code home over the legacy home', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-kimi-home-precedence-'))
        try {
            const currentHome = join(root, '.kimi-code')
            const legacyHome = join(root, '.kimi')
            await mkdir(currentHome, { recursive: true })
            await mkdir(legacyHome, { recursive: true })
            const config = (model: string, baseUrl: string, apiKey: string) => [
                `default_model = "${model}"`,
                `[providers.${model}]`,
                'type = "kimi"',
                `base_url = "${baseUrl}"`,
                `api_key = "${apiKey}"`,
                `[models.${model}]`,
                `provider = "${model}"`
            ].join('\n')
            await writeFile(join(currentHome, 'config.toml'), config('current', 'https://current.kimi.example', 'current-secret'))
            await writeFile(join(legacyHome, 'config.toml'), config('legacy', 'https://legacy.kimi.example', 'legacy-secret'))

            const resolved = await resolveUsageCredentials('kimi', {}, root)
            expect(resolved).toMatchObject({
                baseUrl: 'https://current.kimi.example',
                apiKey: 'current-secret',
                baseUrlSource: 'config',
                apiKeySource: 'config'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('falls back to legacy Kimi credentials when the current config is incomplete', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-kimi-incomplete-current-'))
        try {
            const currentHome = join(root, '.kimi-code')
            const legacyHome = join(root, '.kimi')
            await mkdir(currentHome, { recursive: true })
            await mkdir(legacyHome, { recursive: true })
            const legacyConfig = [
                'default_model = "legacy"',
                '[providers.legacy]',
                'type = "kimi"',
                'base_url = "https://legacy.kimi.example/coding/v1"',
                'api_key = "legacy-secret"',
                '[models.legacy]',
                'provider = "legacy"'
            ].join('\n')
            await writeFile(join(legacyHome, 'config.toml'), legacyConfig)

            await writeFile(join(currentHome, 'config.toml'), [
                'default_model = "current"',
                '[providers.current]',
                'type = "kimi"',
                'api_key = "partial-current-secret"',
                '[models.current]',
                'provider = "current"'
            ].join('\n'))

            const resolved = await resolveUsageCredentials('kimi', {}, root)
            expect(resolved).toMatchObject({
                baseUrl: 'https://legacy.kimi.example/coding/v1',
                apiKey: 'legacy-secret',
                baseUrlSource: 'config',
                apiKeySource: 'config'
            })

            await writeFile(join(currentHome, 'config.toml'), [
                'default_model = "current"',
                '[providers.current]',
                'type = "kimi"',
                'base_url = "https://partial-current.kimi.example/coding/v1"',
                '[models.current]',
                'provider = "current"'
            ].join('\n'))
            const baseOnly = await resolveUsageCredentials('kimi', {}, root)
            expect(baseOnly).toMatchObject({
                baseUrl: 'https://legacy.kimi.example/coding/v1',
                apiKey: 'legacy-secret',
                baseUrlSource: 'config',
                apiKeySource: 'config'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('does not fall through an explicit Kimi home to the default current home', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-kimi-explicit-home-'))
        try {
            const explicitHome = join(root, 'explicit')
            const defaultHome = join(root, '.kimi-code')
            await mkdir(explicitHome, { recursive: true })
            await mkdir(defaultHome, { recursive: true })
            await writeFile(join(explicitHome, 'config.toml'), 'default_model = "explicit/k3"\n')
            await writeFile(join(defaultHome, 'config.toml'), [
                'default_model = "default"',
                '[providers.default]',
                'type = "kimi"',
                'base_url = "https://default.kimi.example/coding/v1"',
                'api_key = "default-secret"',
                '[models.default]',
                'provider = "default"'
            ].join('\n'))

            const resolved = await resolveUsageCredentials('kimi', {
                KIMI_CODE_HOME: explicitHome,
                KIMI_API_KEY: 'explicit-secret'
            }, root)
            expect(resolved).toMatchObject({
                baseUrl: '',
                apiKey: 'explicit-secret',
                baseUrlSource: 'none',
                apiKeySource: 'environment'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('does not infer an inactive Kimi provider without an active model selection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-kimi-inactive-provider-'))
        try {
            const providerConfig = [
                '[providers.inactive]',
                'type = "kimi"',
                'base_url = "https://inactive.kimi.example"',
                'api_key = "config-secret"'
            ].join('\n')
            await writeFile(join(root, 'config.toml'), providerConfig)
            const noDefault = await resolveUsageCredentials('kimi', {
                KIMI_CODE_HOME: root,
                KIMI_API_KEY: 'environment-secret'
            })
            expect(noDefault).toMatchObject({
                baseUrl: '',
                apiKey: 'environment-secret',
                baseUrlSource: 'none',
                apiKeySource: 'environment'
            })

            await writeFile(join(root, 'config.toml'), [
                'default_model = "missing-model"',
                providerConfig
            ].join('\n'))
            const unmapped = await resolveUsageCredentials('kimi', {
                KIMI_CODE_HOME: root,
                KIMI_API_KEY: 'environment-secret'
            })
            expect(unmapped).toMatchObject({
                baseUrl: '',
                apiKey: 'environment-secret',
                baseUrlSource: 'none',
                apiKeySource: 'environment'
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
