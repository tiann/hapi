import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadNamespaceTokens } from './namespaceTokens'

const tempDirs: string[] = []
const originalEnv = process.env.HAPI_NAMESPACE_TOKENS_JSON
const namespaceCredentialDocumentation = [
    '../../../AGENTS.md',
    '../../../cli/README.md',
    '../../../cli/src/runner/README.md',
    '../../../docs/guide/faq.md',
    '../../../docs/guide/installation.md',
    '../../../docs/guide/namespace.md',
    '../../../hub/README.md',
    '../../../web/README.md',
] as const

function createDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-namespace-token-config-'))
    tempDirs.push(dir)
    return dir
}

afterEach(() => {
    if (originalEnv === undefined) {
        delete process.env.HAPI_NAMESPACE_TOKENS_JSON
    } else {
        process.env.HAPI_NAMESPACE_TOKENS_JSON = originalEnv
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('namespace token configuration', () => {
    it('documents independently mapped namespace credentials without token suffixes', () => {
        const obsoleteNamespaceSuffixDocs = namespaceCredentialDocumentation.filter((relativePath) => {
            const contents = readFileSync(
                fileURLToPath(new URL(relativePath, import.meta.url)),
                'utf8',
            )
            return /CLI_API_TOKEN\s*:\s*<namespace>/.test(contents)
        })
        const webReadme = readFileSync(
            fileURLToPath(new URL('../../../web/README.md', import.meta.url)),
            'utf8',
        )
        const agentInstructions = readFileSync(
            fileURLToPath(new URL('../../../AGENTS.md', import.meta.url)),
            'utf8',
        )

        expect(obsoleteNamespaceSuffixDocs).toEqual([])
        expect(webReadme).toContain('HAPI_NAMESPACE_TOKENS_JSON')
        expect(webReadme).toContain('settings.json.namespaceTokens')
        expect(agentInstructions).toContain('independently assigned credential')
        expect(agentInstructions).toContain('server-side')
    })

    it('loads an explicit namespace-to-credential map from settings', async () => {
        const dataDir = createDataDir()
        writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
            namespaceTokens: {
                alice: 'alice-independent-token',
                bob: 'bob-independent-token',
            },
        }))

        const result = await loadNamespaceTokens(dataDir, 'default-independent-token')

        expect(result).toEqual({
            tokens: {
                alice: 'alice-independent-token',
                bob: 'bob-independent-token',
            },
            source: 'file',
            savedToFile: false,
        })
    })

    it('loads and securely persists an environment credential map when settings has none', async () => {
        const dataDir = createDataDir()
        process.env.HAPI_NAMESPACE_TOKENS_JSON = JSON.stringify({
            alice: 'alice-environment-token',
        })

        const result = await loadNamespaceTokens(dataDir, 'default-independent-token')
        const persisted = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as {
            namespaceTokens?: Record<string, string>
        }

        expect(result.source).toBe('env')
        expect(result.savedToFile).toBe(true)
        expect(persisted.namespaceTokens).toEqual({ alice: 'alice-environment-token' })
    })

    it('rejects duplicate, default, reserved, or malformed namespace credentials', async () => {
        const cases: Array<Record<string, string>> = [
            { alice: 'default-independent-token' },
            { alice: 'shared-independent-token', bob: 'shared-independent-token' },
            { default: 'another-independent-token' },
            { 'bad namespace': 'another-independent-token' },
        ]

        for (const namespaceTokens of cases) {
            const dataDir = createDataDir()
            writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ namespaceTokens }))
            await expect(loadNamespaceTokens(dataDir, 'default-independent-token')).rejects.toThrow()
        }
    })
})
