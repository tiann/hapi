import { describe, expect, it, vi } from 'vitest'
import { getBrowserLocalSpeechSupport } from './browserLocalSpeech'

const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'

function speechRecognitionShape(availableDescriptor?: PropertyDescriptor) {
    class MockSpeechRecognition {
        processLocally = false
    }
    Object.defineProperty(MockSpeechRecognition.prototype, 'processLocally', { value: false })
    if (availableDescriptor) Object.defineProperty(MockSpeechRecognition, 'available', availableDescriptor)
    return MockSpeechRecognition
}

describe('browser-local speech capability detection', () => {
    it('uses the static available data property as a no-probe capability requirement', () => {
        const available = vi.fn(() => Promise.resolve('available'))
        const SpeechRecognition = speechRecognitionShape({ value: available })

        const support = getBrowserLocalSpeechSupport({
            userAgent: DESKTOP_USER_AGENT,
            userAgentData: { platform: 'macOS', mobile: false },
            speechRecognition: SpeechRecognition
        })

        expect(support?.constructor).toBe(SpeechRecognition)
        expect(support?.available).toBe(available)
        expect(available).not.toHaveBeenCalled()
    })

    it('rejects missing, non-function, and getter available properties without reading a getter', () => {
        const getter = vi.fn(() => vi.fn(() => Promise.resolve('available')))
        const cases = [
            speechRecognitionShape(),
            speechRecognitionShape({ value: 'available' }),
            speechRecognitionShape({ get: getter })
        ]

        for (const SpeechRecognition of cases) {
            expect(getBrowserLocalSpeechSupport({
                userAgent: DESKTOP_USER_AGENT,
                userAgentData: { platform: 'macOS', mobile: false },
                speechRecognition: SpeechRecognition
            })).toBeNull()
        }

        expect(getter).not.toHaveBeenCalled()
    })

    it('fails closed when a desktop-looking UA has mobile Android UA-CH signals', () => {
        const available = vi.fn(() => Promise.resolve('available'))
        const SpeechRecognition = speechRecognitionShape({ value: available })

        expect(getBrowserLocalSpeechSupport({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
            userAgentData: { platform: 'Android', mobile: true },
            speechRecognition: SpeechRecognition
        })).toBeNull()
        expect(available).not.toHaveBeenCalled()
    })

    it('rejects desktop-looking UAs without trusted desktop UA-CH', () => {
        const available = vi.fn(() => Promise.resolve('available'))
        const SpeechRecognition = speechRecognitionShape({ value: available })

        expect(getBrowserLocalSpeechSupport({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
            speechRecognition: SpeechRecognition
        })).toBeNull()
        expect(getBrowserLocalSpeechSupport({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
            speechRecognition: SpeechRecognition
        })).toBeNull()
        expect(available).not.toHaveBeenCalled()
    })
})
