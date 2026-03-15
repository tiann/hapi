import { beforeEach, describe, expect, it } from 'vitest'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'

describe('NewSession preferences', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('loads defaults when storage is empty', () => {
        expect(loadPreferredAgent()).toBe('claude')
        expect(loadPreferredYoloMode()).toBe(false)
    })

    it('loads saved values from storage', () => {
        localStorage.setItem('zs:newSession:agent', 'codex')
        localStorage.setItem('zs:newSession:yolo', 'true')

        expect(loadPreferredAgent()).toBe('codex')
        expect(loadPreferredYoloMode()).toBe(true)
    })

    it('falls back to default agent on invalid stored value', () => {
        localStorage.setItem('zs:newSession:agent', 'unknown-agent')

        expect(loadPreferredAgent()).toBe('claude')
    })

    it('persists new values to storage', () => {
        savePreferredAgent('gemini')
        savePreferredYoloMode(true)

        expect(localStorage.getItem('zs:newSession:agent')).toBe('gemini')
        expect(localStorage.getItem('zs:newSession:yolo')).toBe('true')
    })
})
