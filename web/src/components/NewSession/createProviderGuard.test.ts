import { describe, expect, it, vi } from 'vitest'
import { guardProviderSelectionAcrossAsyncCheck } from './createProviderGuard'
import type { ProviderReadinessIssue } from '@hapi/protocol'

const staleIssue: ProviderReadinessIssue = {
    ok: false,
    code: 'provider-readiness-stale',
    message: 'Provider readiness is stale.'
}

describe('Create provider guard', () => {
    it('rechecks after the async path lookup and blocks the spawn continuation', async () => {
        let issue: ProviderReadinessIssue | null = null
        const lookup = vi.fn(async () => {
            issue = staleIssue
            return { '/tmp/project': true }
        })

        await expect(guardProviderSelectionAcrossAsyncCheck(
            () => issue,
            lookup
        )).resolves.toEqual({ ok: false, issue: staleIssue })
        expect(lookup).toHaveBeenCalledOnce()
    })

    it('does not start the async lookup when readiness is already invalid', async () => {
        const lookup = vi.fn(async () => ({ '/tmp/project': true }))

        await expect(guardProviderSelectionAcrossAsyncCheck(
            () => staleIssue,
            lookup
        )).resolves.toEqual({ ok: false, issue: staleIssue })
        expect(lookup).not.toHaveBeenCalled()
    })

    it('blocks the spawn continuation when the selected launch inputs change during lookup', async () => {
        let selectionKey = 'machine-a:/tmp/project:grok:high:safe-yolo'
        const lookup = vi.fn(async () => {
            selectionKey = 'machine-b:/tmp/other:codex:high:default'
            return { '/tmp/project': true }
        })

        await expect(guardProviderSelectionAcrossAsyncCheck(
            () => null,
            lookup,
            () => selectionKey
        )).resolves.toEqual({ ok: false, reason: 'selection-changed' })
        expect(lookup).toHaveBeenCalledOnce()
    })
})
