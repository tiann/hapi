import { describe, expect, test } from 'bun:test'
import { buildGeminiLiveSetupMessage, buildQwenSessionUpdateMessage, isQwenSafeClientFrame, GEMINI_LIVE_MODEL, GEMINI_LIVE_VOICE, QWEN_REALTIME_VOICE } from './voice'

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

describe('buildQwenSessionUpdateMessage', () => {
    test('locks voice to HAPI default', () => {
        const msg = buildQwenSessionUpdateMessage()
        const session = msg.session as { voice: string }
        expect(session.voice).toBe(QWEN_REALTIME_VOICE)
    })

    test('includes both tools', () => {
        const msg = buildQwenSessionUpdateMessage()
        const session = msg.session as { tools: Array<{ function: { name: string } }> }
        const names = session.tools.map(t => t.function.name)
        expect(names).toContain('messageCodingAgent')
        expect(names).toContain('processPermissionRequest')
    })

    test('appends Chinese block when language is zh', () => {
        const en = buildQwenSessionUpdateMessage()
        const zh = buildQwenSessionUpdateMessage('zh')
        const enInstr = (en.session as { instructions: string }).instructions
        const zhInstr = (zh.session as { instructions: string }).instructions
        expect(zhInstr.length).toBeGreaterThan(enInstr.length)
    })
})

describe('isQwenSafeClientFrame', () => {
    test('allows non-session.update frames', () => {
        expect(isQwenSafeClientFrame(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'abc' }))).toBe(true)
        expect(isQwenSafeClientFrame(JSON.stringify({ type: 'response.create' }))).toBe(true)
        expect(isQwenSafeClientFrame(JSON.stringify({ type: 'conversation.item.create', item: {} }))).toBe(true)
    })

    test('allows session.update with only instructions', () => {
        expect(isQwenSafeClientFrame(JSON.stringify({
            type: 'session.update',
            session: { instructions: 'updated prompt' }
        }))).toBe(true)
    })

    test('blocks session.update that includes tools', () => {
        expect(isQwenSafeClientFrame(JSON.stringify({
            type: 'session.update',
            session: { instructions: 'x', tools: [] }
        }))).toBe(false)
    })

    test('blocks session.update that includes voice', () => {
        expect(isQwenSafeClientFrame(JSON.stringify({
            type: 'session.update',
            session: { voice: 'Cherry' }
        }))).toBe(false)
    })

    test('blocks full config session.update', () => {
        expect(isQwenSafeClientFrame(JSON.stringify({
            type: 'session.update',
            session: { modalities: ['text', 'audio'], voice: 'Cherry', instructions: 'x', tools: [], tool_choice: 'auto' }
        }))).toBe(false)
    })

    test('allows non-JSON (binary audio frames pass through)', () => {
        expect(isQwenSafeClientFrame('not json {')).toBe(true)
    })
})
