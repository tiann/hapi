import { describe, expect, it } from 'vitest'
import { generatedInlineMediaLabel, isInlineAudioMimeType, isInlineVideoMimeType } from './generatedInlineMedia'

describe('generatedInlineMedia', () => {
    it('detects inline video MIME types', () => {
        expect(isInlineVideoMimeType('video/mp4')).toBe(true)
        expect(isInlineVideoMimeType('video/webm')).toBe(true)
        expect(isInlineVideoMimeType('image/png')).toBe(false)
        expect(isInlineVideoMimeType(null)).toBe(false)
    })

    it('labels generated inline media by MIME type', () => {
        expect(generatedInlineMediaLabel('video/mp4')).toBe('Generated video')
        expect(generatedInlineMediaLabel('image/png')).toBe('Generated image')
        expect(generatedInlineMediaLabel('audio/wav')).toBe('Generated audio')
        expect(generatedInlineMediaLabel('application/octet-stream')).toBe('Generated file')
        expect(generatedInlineMediaLabel(null)).toBe('Generated image')
        expect(isInlineAudioMimeType('audio/mpeg')).toBe(true)
    })
})
