import { describe, expect, it } from 'vitest'
import { parsePiModelsTable } from './piModels'

const SAMPLE_TABLE = `provider      model                     context  max-out  thinking  images
openai-codex  gpt-5.3-codex-spark       128K     128K     yes       no
openai-codex  gpt-5.6-sol               272K     128K     yes       yes
opencode-go   deepseek-v4-pro           1M       384K     yes       no
opencode-go   gpt-5.6-luna              1.1M     128K     yes       yes
opencode-go   qwen3.6-plus              1M       65.5K    yes       yes
`

describe('parsePiModelsTable', () => {
    it('parses provider/model columns and reasoning flag', () => {
        const models = parsePiModelsTable(SAMPLE_TABLE)
        expect(models).toEqual([
            { provider: 'openai-codex', modelId: 'gpt-5.3-codex-spark', reasoning: true },
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol', reasoning: true },
            { provider: 'opencode-go', modelId: 'deepseek-v4-pro', reasoning: true },
            { provider: 'opencode-go', modelId: 'gpt-5.6-luna', reasoning: true },
            { provider: 'opencode-go', modelId: 'qwen3.6-plus', reasoning: true },
        ])
    })

    it('skips the header, separators, and short lines', () => {
        const models = parsePiModelsTable(`provider model context max-out thinking images
=== === === === === ===
junk
`)
        expect(models).toEqual([])
    })

    it('treats non-reasoning models as reasoning false', () => {
        const models = parsePiModelsTable(`provider      model                     context  max-out  thinking  images
anthropic     claude-haiku             200K     64K      no        no
`)
        expect(models).toEqual([{ provider: 'anthropic', modelId: 'claude-haiku', reasoning: false }])
    })

    it('dedupes identical provider/model pairs', () => {
        const models = parsePiModelsTable(SAMPLE_TABLE + 'openai-codex  gpt-5.6-sol               272K     128K     yes       yes\n')
        expect(models.filter((m) => m.modelId === 'gpt-5.6-sol')).toHaveLength(1)
    })
})
