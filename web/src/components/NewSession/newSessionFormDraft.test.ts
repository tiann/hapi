import { afterEach, describe, expect, it } from 'vitest'
import {
    clearNewSessionFormDraft,
    loadNewSessionFormDraft,
    newSessionDraftMatchesMachine,
    saveNewSessionFormDraft,
    shouldRestoreNewSessionFormDraft
} from './newSessionFormDraft'

describe('newSessionFormDraft', () => {
    afterEach(() => {
        clearNewSessionFormDraft()
    })

    it('round-trips cursor model fields through sessionStorage', () => {
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'composer-2.5[fast=false]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            yoloMode: false,
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        expect(loadNewSessionFormDraft()).toEqual({
            agent: 'cursor',
            model: 'composer-2.5[fast=false]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'default',
            yoloMode: false,
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })
    })

    it('restores only when returning from browse with a directory in search', () => {
        expect(shouldRestoreNewSessionFormDraft({})).toBe(false)
        expect(shouldRestoreNewSessionFormDraft({ initialDirectory: '/tmp/proj' })).toBe(true)
        expect(shouldRestoreNewSessionFormDraft({
            initialDirectory: '/tmp/proj',
            initialMachineId: 'machine-1'
        })).toBe(true)
    })

    it('matches machine when draft has no machine id', () => {
        const draft = loadNewSessionFormDraft()
        void draft
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: null,
            effort: 'auto',
            modelReasoningEffort: 'default',
            yoloMode: false,
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })
        const loaded = loadNewSessionFormDraft()!
        expect(newSessionDraftMatchesMachine(loaded, 'machine-1')).toBe(true)
    })

    it('rejects draft when machine id differs', () => {
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-a',
            effort: 'auto',
            modelReasoningEffort: 'default',
            yoloMode: false,
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })
        const draft = loadNewSessionFormDraft()!
        expect(newSessionDraftMatchesMachine(draft, 'machine-b')).toBe(false)
    })

    it('coerces a stale uncreatable agent (gemini) to claude and resets dependent fields', () => {
        saveNewSessionFormDraft({
            agent: 'gemini',
            model: 'gemini-2.5-pro',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'high',
            modelReasoningEffort: 'high',
            yoloMode: true,
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('claude')
        // agent-dependent fields reset so a Gemini model isn't carried into Claude
        expect(loaded.model).toBe('auto')
        expect(loaded.cursorSelectedBase).toBe('auto')
        expect(loaded.effort).toBe('auto')
        expect(loaded.modelReasoningEffort).toBe('default')
        // agent-independent fields preserved
        expect(loaded.yoloMode).toBe(true)
        expect(loaded.machineId).toBe('machine-1')
    })
})
