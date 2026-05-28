import { describe, expect, test } from 'bun:test'
import { buildGeminiLiveSetupMessage, GEMINI_LIVE_MODEL, GEMINI_LIVE_VOICE } from './voice'

describe('buildGeminiLiveSetupMessage', () => {
    test('locks model and voice to HAPI defaults', () => {
        const msg = buildGeminiLiveSetupMessage()
        expect(msg.setup.model).toBe(`models/${GEMINI_LIVE_MODEL}`)
        const speech = msg.setup.generationConfig as {
            speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } }
        }
        expect(speech.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(GEMINI_LIVE_VOICE)
    })

    test('appends Chinese block when language is zh', () => {
        const en = buildGeminiLiveSetupMessage()
        const zh = buildGeminiLiveSetupMessage('zh')
        const enText = (en.setup.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text
        const zhText = (zh.setup.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text
        expect(zhText.length).toBeGreaterThan(enText.length)
    })
})
