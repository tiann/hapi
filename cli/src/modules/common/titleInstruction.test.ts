import { afterEach, describe, expect, it } from 'vitest'
import {
    applyHubAutoTitlePerTurn,
    buildPerTurnTitleParagraph,
    isAutoTitlePerTurnEnabled,
    resetAutoTitlePerTurnForTests
} from './titleInstruction'

describe('titleInstruction', () => {
    afterEach(() => {
        resetAutoTitlePerTurnForTests()
    })

    it('is disabled by default (upstream sparing steer stays)', () => {
        expect(isAutoTitlePerTurnEnabled({})).toBe(false)
        expect(isAutoTitlePerTurnEnabled({ HAPI_AUTO_TITLE_PER_TURN: '' })).toBe(false)
    })

    it('enables when hub preference is applied', () => {
        applyHubAutoTitlePerTurn(true)
        expect(isAutoTitlePerTurnEnabled({})).toBe(true)

        applyHubAutoTitlePerTurn(false)
        expect(isAutoTitlePerTurnEnabled({})).toBe(false)
    })

    it('lets explicit env override hub preference', () => {
        applyHubAutoTitlePerTurn(true)
        expect(isAutoTitlePerTurnEnabled({ HAPI_AUTO_TITLE_PER_TURN: '0' })).toBe(false)
        applyHubAutoTitlePerTurn(false)
        expect(isAutoTitlePerTurnEnabled({ HAPI_AUTO_TITLE_PER_TURN: '1' })).toBe(true)
        expect(isAutoTitlePerTurnEnabled({ HAPI_AUTO_TITLE_PER_TURN: 'true' })).toBe(true)
    })

    it('treats common falsy env spellings as off', () => {
        for (const value of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
            expect(isAutoTitlePerTurnEnabled({ HAPI_AUTO_TITLE_PER_TURN: value })).toBe(false)
        }
    })

    it('builds a per-turn paragraph naming the flavor tool id', () => {
        const paragraph = buildPerTurnTitleParagraph('mcp__hapi__change_title')
        expect(paragraph).toContain('"mcp__hapi__change_title"')
        expect(paragraph).toContain('before finishing each user turn')
        expect(paragraph).toContain('Rewrite the title every turn')
        expect(paragraph).not.toContain('sparingly')

        const codex = buildPerTurnTitleParagraph('functions.hapi__change_title')
        expect(codex).toContain('"functions.hapi__change_title"')
    })
})

describe('claude system prompt title steer', () => {
    afterEach(() => {
        resetAutoTitlePerTurnForTests()
        delete process.env.HAPI_AUTO_TITLE_PER_TURN
    })

    it('keeps the sparing paragraph byte-identical when off', async () => {
        const { getSystemPrompt } = await import('@/claude/utils/systemPrompt')
        const prompt = getSystemPrompt({})
        expect(prompt).toContain('Use the title tool sparingly.')
        expect(prompt).toContain('"mcp__hapi__change_title" once after the user\'s initial request is clear')
        expect(prompt).not.toContain('Per-turn title updates are enabled')
    })

    it('swaps in the per-turn steer when enabled', async () => {
        applyHubAutoTitlePerTurn(true)
        const { getSystemPrompt } = await import('@/claude/utils/systemPrompt')
        const prompt = getSystemPrompt({})
        expect(prompt).toContain('Per-turn title updates are enabled for this hub')
        expect(prompt).toContain('"mcp__hapi__change_title"')
        expect(prompt).not.toContain('Use the title tool sparingly.')
        // Display / citation blocks stay in place either way.
        expect(prompt).toContain('mcp__hapi__display_image')
    })
})
