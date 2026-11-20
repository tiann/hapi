import { afterEach, describe, expect, it } from 'vitest'

import { state } from './telemetry/state'
import { installForTest, resetTelemetryForTest, settle, stubTelemetryFetch } from './telemetry/testHelpers'
import { telemetry } from './telemetry'
import { telemetryClient } from './telemetryClient'

/**
 * Cross-slice seam test (integration-only): the capture slice's facade
 * (`telemetryClient`, glob-resolved) must bind to the REAL SDK singleton from
 * `web/src/lib/telemetry` now that both slices live on one tree. The capture
 * slice was developed on a branch where the SDK was absent (facade no-op);
 * this file pins the binding so a future module rename fails loudly instead
 * of silently producing zero telemetry.
 */
describe('telemetryClient binding to the real SDK (cross-slice seam)', () => {
    afterEach(() => {
        resetTelemetryForTest()
    })

    it('glob resolved the real singleton: setTrigger writes through the facade and is observable on the SDK', () => {
        telemetryClient.setTrigger('session-open')
        expect(telemetry.getTrigger()).toBe('session-open')
        telemetryClient.setTrigger(null)
        expect(telemetry.getTrigger()).toBeNull()
    })

    it('capture flows through the facade into the real SDK queue', async () => {
        const kit = stubTelemetryFetch({ level: 1 })
        installForTest(kit)
        await settle()

        telemetryClient.capture('ux', 'session_open', { entry: 'list-click', openedAt: 1 }, { sessionId: 's1' })

        const queued = state.queue.map((q) => q.ev)
        expect(queued).toHaveLength(1)
        expect(queued[0]!.kind).toBe('session_open')
        expect(queued[0]!.sessionId).toBe('s1')
        expect(queued[0]!.domain).toBe('ux')
        // 门控关闭时 facade 不炸、不产生数据(等级 0 = 全 no-op 契约)
        state.level = 0
        expect(() => telemetryClient.capture('ux', 'session_close', { wallDwellMs: 1, visibleDwellMs: 1, exit: 'switch' })).not.toThrow()
        expect(state.queue.map((q) => q.ev)).toHaveLength(1)
    })
})
