import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderRegistry } from './providerRegistry'
import { resolveProviderLaunch } from './providerAdapters'

const created: string[] = []

afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ProviderRegistry', () => {
    it('stores secrets locally while returning only redacted views', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-'))
        created.push(directory)
        const filePath = join(directory, 'providers.json')
        const registry = new ProviderRegistry({ filePath, namespace: 'alice' })
        const createdProfile = await registry.create({
            name: 'Claude proxy',
            agent: 'claude',
            protocol: 'anthropic-messages',
            baseUrl: 'https://example.com',
            credentialType: 'api-key',
            apiKey: 'secret-value-1234',
            enabled: true
        })

        expect(createdProfile).toMatchObject({ hasSecret: true, secretHint: '••••1234' })
        expect(createdProfile).not.toHaveProperty('apiKey')
        expect(await readFile(filePath, 'utf8')).toContain('secret-value-1234')
        if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600)

        const resolved = await registry.resolve('claude')
        expect(resolved?.id).toBe(createdProfile.id)
        expect(await registry.resolve('claude', null)).toBeNull()
    })

    it('updates profiles without erasing an omitted secret and builds agent-specific launch config', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-update-'))
        created.push(directory)
        const registry = new ProviderRegistry({ filePath: join(directory, 'providers.json'), namespace: 'default' })
        const view = await registry.create({
            name: 'Codex proxy',
            agent: 'codex',
            protocol: 'openai-responses',
            baseUrl: 'https://codex.example/v1',
            credentialType: 'api-key',
            apiKey: 'codex-secret',
            codexWireApi: 'responses',
            enabled: true
        })
        await registry.update(view.id, { name: 'Renamed' })
        const resolved = await registry.resolve('codex', view.id)
        expect(resolved?.apiKey).toBe('codex-secret')
        const launch = resolveProviderLaunch('codex', resolved!)
        expect(launch.env.HAPI_CODEX_PROVIDER_API_KEY).toBe('codex-secret')
        expect(launch.args.join(' ')).toContain('model_provider')
        expect(launch.args.join(' ')).not.toContain('codex-secret')
    })

    it('isolates profiles by namespace', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-namespace-'))
        created.push(directory)
        const filePath = join(directory, 'providers.json')
        const alice = new ProviderRegistry({ filePath, namespace: 'alice' })
        const bob = new ProviderRegistry({ filePath, namespace: 'bob' })
        await alice.create({
            name: 'Alice only',
            agent: 'claude',
            protocol: 'anthropic-messages',
            credentialType: 'api-key',
            apiKey: 'alice-secret',
            enabled: true
        })
        expect((await alice.list()).profiles).toHaveLength(1)
        expect((await bob.list()).profiles).toHaveLength(0)
    })

    it('does not leave a disabled profile selected as the machine default', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-default-'))
        created.push(directory)
        const registry = new ProviderRegistry({ filePath: join(directory, 'providers.json'), namespace: 'default' })
        const disabled = await registry.create({
            name: 'Disabled',
            agent: 'claude',
            protocol: 'anthropic-messages',
            credentialType: 'api-key',
            apiKey: 'secret',
            enabled: false
        })
        expect((await registry.list()).defaults?.claude).toBeNull()

        const enabled = await registry.create({
            name: 'Enabled',
            agent: 'claude',
            protocol: 'anthropic-messages',
            credentialType: 'api-key',
            apiKey: 'secret',
            enabled: true
        })
        expect((await registry.list()).defaults?.claude).toBe(enabled.id)
        await registry.update(enabled.id, { enabled: false })
        expect((await registry.list()).defaults?.claude).toBeNull()
        expect(await registry.resolve('claude')).toBeNull()
        expect(disabled.enabled).toBe(false)
    })

    it('rejects unsupported Codex auth-token credentials', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-credential-'))
        created.push(directory)
        const registry = new ProviderRegistry({ filePath: join(directory, 'providers.json'), namespace: 'default' })
        await expect(registry.create({
            name: 'Invalid Codex profile',
            agent: 'codex',
            protocol: 'openai-responses',
            credentialType: 'auth-token',
            apiKey: 'secret',
            enabled: true
        })).rejects.toThrow(/credential type/)
    })

    it('preserves custom context declarations when health checks refresh discovered models', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-models-'))
        created.push(directory)
        const registry = new ProviderRegistry({ filePath: join(directory, 'providers.json'), namespace: 'default' })
        const profile = await registry.create({
            name: 'Compatible proxy',
            agent: 'codex',
            protocol: 'openai-chat-completions',
            credentialType: 'api-key',
            apiKey: 'secret',
            defaultModel: 'glm-5.2[1M]',
            models: ['glm-5.2[1M]'],
            enabled: true
        })

        await registry.recordHealthCheck(profile.id, {
            success: true,
            status: 'healthy',
            checkedAt: 123,
            models: [
                { id: 'gpt-5', contextWindow: 200_000, source: 'provider' },
                { id: 'glm-5.2', contextWindow: 200_000, source: 'provider' }
            ]
        })

        const listed = (await registry.list()).profiles?.[0]
        expect(listed?.defaultModel).toBe('glm-5.2[1M]')
        expect(listed?.models).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'glm-5.2', contextWindow: 1_000_000, source: 'custom' }),
            expect.objectContaining({ id: 'gpt-5', contextWindow: 200_000, source: 'provider', refreshedAt: 123 })
        ]))
        expect((await registry.resolve('codex', profile.id))?.defaultModel).toBe('glm-5.2[1M]')
    })

    it('maps the selected protocol to launch-time credentials without exposing a model display tag', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-providers-grok-'))
        created.push(directory)
        const registry = new ProviderRegistry({ filePath: join(directory, 'providers.json'), namespace: 'default' })
        const profile = await registry.create({
            name: 'Grok official',
            agent: 'grok',
            protocol: 'openai-chat-completions',
            credentialType: 'api-key',
            apiKey: 'xai-secret',
            defaultModel: 'grok-4.1[1M]',
            enabled: true
        })

        const launch = resolveProviderLaunch('grok', (await registry.resolve('grok', profile.id))!)
        expect(launch.env.XAI_API_KEY).toBe('xai-secret')
        expect(launch.defaultModel).toBe('grok-4.1[1M]')
    })
})
