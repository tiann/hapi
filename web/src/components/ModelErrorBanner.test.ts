import { describe, expect, it } from 'vitest'
import {
    canShowModelErrorBridge,
    getModelErrorUiState,
    hasActiveModelError,
    hasRecoveredModelError,
    hasUrgentModelError,
    isBridgeSettling,
    shouldKeepPendingBridge,
    visibleBridgeFailureReason,
    type ModelErrorHolder
} from './ModelErrorBanner'
import { getEventPresentation } from '@/chat/presentation'

function holder(partial: NonNullable<ModelErrorHolder['lastModelError']>): ModelErrorHolder {
    return { lastModelError: partial }
}

describe('model error UI states', () => {
    const base = {
        eventId: 'evt-1000',
        kind: 'transport_closed',
        transient: true,
        rawSnippet: 'WritableIterable is closed',
        atTs: 1000,
        priorAssistantClaimsDone: false
    }

    it('treats unacked unrecovered errors as urgent', () => {
        const metadata = holder(base)
        expect(getModelErrorUiState(metadata)).toBe('unrecovered')
        expect(hasUrgentModelError(metadata)).toBe(true)
        expect(hasRecoveredModelError(metadata)).toBe(false)
        expect(canShowModelErrorBridge(metadata)).toBe(true)
    })

    it('treats bridged errors as recovered (not urgent)', () => {
        const metadata = holder({ ...base, bridgedForEventId: 'evt-1000' })
        expect(getModelErrorUiState(metadata)).toBe('recovered')
        expect(hasUrgentModelError(metadata)).toBe(false)
        expect(hasRecoveredModelError(metadata)).toBe(true)
        expect(hasActiveModelError(metadata)).toBe(true)
        expect(canShowModelErrorBridge(metadata)).toBe(false)
    })

    it('treats retriedAndFailed as bridge_failed / urgent', () => {
        const metadata = holder({ ...base, bridgedForEventId: 'evt-1000', retriedAndFailed: true })
        expect(getModelErrorUiState(metadata)).toBe('bridge_failed')
        expect(hasUrgentModelError(metadata)).toBe(true)
        expect(canShowModelErrorBridge(metadata)).toBe(false)
    })

    it('hides acknowledged errors', () => {
        const metadata = holder({ ...base, acknowledgedAt: 2000 })
        expect(getModelErrorUiState(metadata)).toBeNull()
        expect(hasActiveModelError(metadata)).toBe(false)
    })

    it('hides Bridge when a newer turn superseded the error', () => {
        const metadata = holder({ ...base, supersededByUserTurn: true })
        expect(getModelErrorUiState(metadata)).toBe('unrecovered')
        expect(canShowModelErrorBridge(metadata)).toBe(false)
    })

    it('hides Bridge when bridgeable is explicitly false', () => {
        const metadata = holder({ ...base, bridgeable: false })
        expect(getModelErrorUiState(metadata)).toBe('unrecovered')
        expect(canShowModelErrorBridge(metadata)).toBe(false)
    })

    it('keeps Bridge settling after enqueue until metadata records an outcome', () => {
        const unrecovered = holder(base)
        expect(isBridgeSettling(unrecovered, 'evt-1000')).toBe(true)
        expect(isBridgeSettling(unrecovered, 'evt-other')).toBe(false)
        expect(isBridgeSettling(holder({ ...base, bridgedForEventId: 'evt-1000' }), 'evt-1000')).toBe(false)
        expect(isBridgeSettling(holder({ ...base, retriedAndFailed: true }), 'evt-1000')).toBe(false)
        expect(isBridgeSettling(holder({ ...base, supersededByUserTurn: true }), 'evt-1000')).toBe(false)
        expect(isBridgeSettling(holder({ ...base, acknowledgedAt: 2000 }), 'evt-1000')).toBe(false)
        expect(isBridgeSettling(unrecovered, null)).toBe(false)
    })

    it('scopes a Bridge failure reason to the requested eventId', () => {
        const failure = { eventId: 'evt-1000', reason: 'not_bridgeable' }
        expect(visibleBridgeFailureReason(failure, 'evt-1000')).toBe('not_bridgeable')
        expect(visibleBridgeFailureReason(failure, 'evt-2000')).toBeNull()
        expect(visibleBridgeFailureReason(null, 'evt-1000')).toBeNull()
    })

    it('drops local Bridge pending across a session disconnect', () => {
        expect(shouldKeepPendingBridge(true, true)).toBe(true)
        expect(shouldKeepPendingBridge(false, true)).toBe(false)
        expect(shouldKeepPendingBridge(true, false)).toBe(false)
    })

    it('drops local Bridge pending after Abort even while still active and unrecovered', () => {
        expect(shouldKeepPendingBridge(true, true, true)).toBe(false)
    })
})

describe('model error chat event labels', () => {
    it('renders modelError and modelErrorBridged labels', () => {
        expect(getEventPresentation({
            type: 'modelError',
            kind: 'transport_closed',
            transient: true
        } as never).text).toContain('transport_closed')

        expect(getEventPresentation({
            type: 'modelErrorBridged',
            kind: 'transport_closed',
            auto: true,
            eventId: 'evt-1'
        } as never).text).toContain('auto-bridged')

        expect(getEventPresentation({
            type: 'modelErrorBridged',
            kind: 'transport_closed',
            auto: false,
            eventId: 'evt-1'
        } as never).text).toMatch(/HAPI bridged after/)
    })
})
