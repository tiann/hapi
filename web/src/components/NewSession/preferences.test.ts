import { beforeEach, describe, expect, it } from 'vitest'
import {
    loadPreferredAgent,
    loadPreferredLaunchSettings,
    loadPreferredYoloMode,
    resolvePreferredLaunchSettings,
    savePreferredAgent,
    savePreferredLaunchSettings,
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

    it('falls back to default agent on invalid stored value', () => {
        localStorage.setItem('hapi:newSession:agent', 'unknown-agent')

        expect(loadPreferredAgent()).toBe('claude')
    })

    it('persists new values to storage', () => {
        savePreferredAgent('gemini')
        savePreferredYoloMode(true)

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('gemini')
        expect(localStorage.getItem('hapi:newSession:yolo')).toBe('true')
    })

    it('round-trips launch settings per machine and agent', () => {
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'safe-yolo'
        })
        savePreferredLaunchSettings('machine-1', 'claude', {
            model: 'opus',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default'
        })
        savePreferredLaunchSettings('machine-2', 'codex', {
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'max'
        })

        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toEqual({
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'safe-yolo'
        })
        expect(loadPreferredLaunchSettings('machine-1', 'claude')).toEqual({
            model: 'opus',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default'
        })
        expect(loadPreferredLaunchSettings('machine-2', 'codex')).toEqual({
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'max'
        })
    })

    it('returns null when no launch settings were saved for the target', () => {
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'high'
        })

        expect(loadPreferredLaunchSettings('machine-2', 'codex')).toBeNull()
        expect(loadPreferredLaunchSettings('machine-1', 'claude')).toBeNull()
    })

    it('fills missing optional launch fields from older stored values', () => {
        localStorage.setItem(
            'hapi:newSession:launchSettings:v1:machine-1:codex',
            JSON.stringify({ model: 'gpt-5.6-sol' })
        )

        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toEqual({
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })
    })

    it('ignores malformed launch settings', () => {
        localStorage.setItem(
            'hapi:newSession:launchSettings:v1:machine-1:codex',
            '{not-json'
        )
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()

        localStorage.setItem(
            'hapi:newSession:launchSettings:v1:machine-1:codex',
            JSON.stringify({ model: 42 })
        )
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
    })

    it('keeps a remembered Claude model the static fallback does not carry', () => {
        // The Claude list is the live CLI catalog, so the static fallback is not
        // an allowlist. Clamping against it would silently discard both a
        // catalog-only model and a legacy '[1m]' alias saved before that pair
        // was dropped from the offer list. The effort value still clamps.
        expect(resolvePreferredLaunchSettings('claude', {
            model: 'sonnet[1m]',
            cursorSelectedBase: 'auto',
            effort: 'ultra',
            modelReasoningEffort: 'default'
        })).toEqual({
            model: 'sonnet[1m]',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })
        expect(resolvePreferredLaunchSettings('claude', {
            model: 'opusplan',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        }).model).toBe('opusplan')
    })

    it('still clamps a remembered model for a flavor whose list is static', () => {
        // Claude leaving the clamp took the only coverage of its true branch
        // with it; agy is one of the flavors the clamp still governs.
        expect(resolvePreferredLaunchSettings('agy', {
            model: 'retired-model',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        }).model).toBe('auto')
    })

    it('keeps dynamic model values for catalog validation after restore', () => {
        expect(resolvePreferredLaunchSettings('codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'read-only'
        })).toEqual({
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'read-only'
        })
    })

    it('falls back when a remembered permission mode is invalid for the agent', () => {
        expect(resolvePreferredLaunchSettings('codex', {
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'bypassPermissions'
        })).toEqual({
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'default'
        })
    })

    it('migrates the legacy YOLO preference for Codex only', () => {
        savePreferredYoloMode(true)

        expect(resolvePreferredLaunchSettings('codex', null, true).permissionMode).toBe('yolo')
        expect(resolvePreferredLaunchSettings('copilot', null, true).permissionMode).toBe('default')
        expect(resolvePreferredLaunchSettings('codex', null, false).permissionMode).toBe('default')
    })

    it.each([
        ['kimi', 'safe-yolo'],
        ['opencode', 'plan']
    ] as const)('restores remembered permission modes for %s', (agent, permissionMode) => {
        savePreferredLaunchSettings('machine-1', agent, {
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default',
            permissionMode
        })

        const preferred = loadPreferredLaunchSettings('machine-1', agent)
        expect(resolvePreferredLaunchSettings(agent, preferred).permissionMode).toBe(permissionMode)
    })

    it('drops an OpenCode reasoning value that is not offered at launch', () => {
        expect(resolvePreferredLaunchSettings('opencode', {
            model: 'provider/model',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh'
        })).toEqual({
            model: 'provider/model',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'default'
        })
    })
})
