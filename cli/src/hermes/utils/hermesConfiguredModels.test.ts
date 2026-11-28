import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHermesConfigModels } from './hermesConfiguredModels'

const tempDirs: string[] = []

function writeTempConfig(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'config.yaml')
    writeFileSync(filePath, content, 'utf8')
    return filePath
}

describe('resolveHermesConfigModels', () => {
    afterEach(() => {
        while (tempDirs.length > 0) {
            rmSync(tempDirs.pop()!, { recursive: true, force: true })
        }
    })

    it('returns configured custom provider models when model.provider matches providers.<name>', () => {
        const filePath = writeTempConfig(`
model:
  provider: magpie
  default: group/agy-tencent
providers:
  magpie:
    models:
      - group/agy-tencent
      - gemini/gemini-3.5-flash-lite
  magpie-anthropic:
    models:
      - agy-wsl/claude-opus-5-5-high
`)
        const models = resolveHermesConfigModels(filePath, 'custom:group/agy-tencent')
        expect(models).toEqual([
            {
                modelId: 'custom:group/agy-tencent',
                name: 'group/agy-tencent',
                description: 'Provider: magpie'
            },
            {
                modelId: 'custom:gemini/gemini-3.5-flash-lite',
                name: 'gemini/gemini-3.5-flash-lite',
                description: 'Provider: magpie'
            },
            {
                modelId: 'custom:magpie-anthropic:agy-wsl/claude-opus-5-5-high',
                name: 'agy-wsl/claude-opus-5-5-high',
                description: 'Provider: magpie-anthropic'
            }
        ])
    })

    it('returns null for built-in providers not defined under providers', () => {
        const filePath = writeTempConfig(`
model:
  provider: openrouter
`)
        expect(resolveHermesConfigModels(filePath, 'openrouter:anthropic/claude-sonnet-4')).toBeNull()
    })
})
