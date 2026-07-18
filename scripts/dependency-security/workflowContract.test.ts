import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'bun:test'

const workflowPaths = {
    release: '.github/workflows/release.yml',
    test: '.github/workflows/test.yml',
    web: '.github/workflows/webapp.yml'
} as const

const frozenInstall = 'bun install --frozen-lockfile'
const dependencyGate = 'bun run dependency:security -- --out "$RUNNER_TEMP/dependency-security" --as-of "$(date -u +%F)"'

async function workflow(name: keyof typeof workflowPaths): Promise<string> {
    return await readFile(workflowPaths[name], 'utf8')
}

function index(text: string, marker: string): number {
    const value = text.indexOf(marker)
    expect(value, `missing workflow marker: ${marker}`).toBeGreaterThanOrEqual(0)
    return value
}

function expectOrdered(text: string, earlier: string, later: string): void {
    expect(index(text, earlier), `${earlier} must precede ${later}`).toBeLessThan(index(text, later))
}

describe('dependency-security workflow contract', () => {
    test('the root full-test gate runs the dependency-security and Shared suites', async () => {
        const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
            scripts: Record<string, string>
        }
        expect(manifest.scripts['test:dependency-security']).toBe('bun test scripts/dependency-security')
        expect(manifest.scripts['test:shared']).toBe('bun test shared/src')
        expect(manifest.scripts.test.split(' && ')).toContain('bun run test:dependency-security')
        expect(manifest.scripts.test.split(' && ')).toContain('bun run test:shared')
    })

    test('tag releases reuse and wait for the complete Test workflow', async () => {
        const testWorkflow = await workflow('test')
        const releaseWorkflow = await workflow('release')

        expect(testWorkflow).toContain('workflow_call:')
        expect(releaseWorkflow).toContain('uses: ./.github/workflows/test.yml')
        expectOrdered(releaseWorkflow, 'test:', 'release:')
        expectOrdered(releaseWorkflow, 'needs: test', 'bun run build:single-exe:all')
    })

    test('operator documentation names the emitted SBOM manifest', async () => {
        const documentation = await readFile('security/dependencies/README.md', 'utf8')
        expect(documentation).toContain('`hapi-sbom-manifest.json`')
        expect(documentation).not.toContain('`dependency-sbom-manifest.json`')
    })

    test('every workflow gates the frozen graph before tests, builds, packages, or deployment', async () => {
        const testWorkflow = await workflow('test')
        const webWorkflow = await workflow('web')
        const releaseWorkflow = await workflow('release')

        for (const text of [testWorkflow, webWorkflow, releaseWorkflow]) {
            expectOrdered(text, frozenInstall, dependencyGate)
            const gateStep = text.slice(index(text, '- name: Gate dependency security policy'), text.indexOf('\n            - ', index(text, '- name: Gate dependency security policy') + 1))
            expect(gateStep).not.toContain('continue-on-error')
        }

        for (const marker of ['bun typecheck', 'Run controlled Runner integration suite', 'bun run test', 'bun run build', 'playwright test']) {
            expectOrdered(testWorkflow, dependencyGate, marker)
        }
        for (const marker of ['Build web app', 'Upload artifact', 'Deploy to GitHub Pages']) {
            expectOrdered(webWorkflow, dependencyGate, marker)
        }
        for (const marker of ['bun run build:single-exe:all', 'Package release artifacts', 'Create Release']) {
            expectOrdered(releaseWorkflow, dependencyGate, marker)
        }
    })

    test('Web deployment watches every dependency-governance input', async () => {
        const text = await workflow('web')
        const requiredPaths = [
            'bun.lock',
            'package.json',
            'cli/package.json',
            'shared/package.json',
            'shared/src/**',
            'hub/package.json',
            'web/package.json',
            'website/package.json',
            'docs/package.json',
            'tools/hapi-codex-sync/package.json',
            'tools/hapi-codex-sync/package-lock.json',
            'scripts/dependency-security/**',
            'security/dependencies/**'
        ]

        for (const path of requiredPaths) {
            expect(text, `missing Web workflow path filter: ${path}`).toContain(`- '${path}'`)
        }
    })

    test('release generates and copies deterministic security artifacts before checksums', async () => {
        const text = await workflow('release')
        const sbomCommand = 'bun run dependency:sbom -- --out "$RUNNER_TEMP/dependency-security" --git-sha "$GITHUB_SHA"'
        const checksum = 'sha256sum * > checksums.txt'
        const copies = [
            'cp "$RUNNER_TEMP/dependency-security/hapi.cdx.json" ../release-artifacts/',
            'cp "$RUNNER_TEMP/dependency-security/hapi-codex-sync.cdx.json" ../release-artifacts/',
            'cp "$RUNNER_TEMP/dependency-security/hapi-sbom-manifest.json" ../release-artifacts/',
            'cp "$RUNNER_TEMP/dependency-security/dependency-audit-summary.json" ../release-artifacts/'
        ]

        expectOrdered(text, dependencyGate, sbomCommand)
        expectOrdered(text, sbomCommand, 'Package release artifacts')
        for (const copy of copies) {
            expectOrdered(text, copy, checksum)
        }
    })
})
