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
        localStorage.setItem('hapi:newSession:agent', 'codex')
        localStorage.setItem('hapi:newSession:yolo', 'true')

        expect(loadPreferredAgent()).toBe('codex')
        expect(loadPreferredYoloMode()).toBe(true)
    })

    it('loads CC-ark as a saved agent value', () => {
        localStorage.setItem('hapi:newSession:agent', 'claude-ark')

        expect(loadPreferredAgent()).toBe('claude-ark')
    })

    it('loads CC-api as a saved agent value', () => {
        localStorage.setItem('hapi:newSession:agent', 'cc-api')

        expect(loadPreferredAgent()).toBe('cc-api')
    })

    it('loads Hermes MoA as a saved agent value', () => {
        localStorage.setItem('hapi:newSession:agent', 'hermes-moa')

        expect(loadPreferredAgent()).toBe('hermes-moa')
    })

    it('falls back to default agent on invalid stored value', () => {
        localStorage.setItem('hapi:newSession:agent', 'unknown-agent')

        expect(loadPreferredAgent()).toBe('claude')
    })

    it('persists new values to storage', () => {
        savePreferredAgent('agy')
        savePreferredYoloMode(true)

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('agy')
        expect(localStorage.getItem('hapi:newSession:yolo')).toBe('true')
    })

    it('persists CC-ark as a preferred agent value', () => {
        savePreferredAgent('claude-ark')

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('claude-ark')
    })

    it('persists CC-api as a preferred agent value', () => {
        savePreferredAgent('cc-api')

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('cc-api')
    })

    it('persists Hermes MoA as a preferred agent value', () => {
        savePreferredAgent('hermes-moa')

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('hermes-moa')
    })
})
