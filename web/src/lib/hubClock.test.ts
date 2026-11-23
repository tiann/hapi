import { expect, it, vi } from 'vitest'
import { HubClock } from './hubClock'
import { isAttachedJobStale } from './attachedJob'

it.each([-1, 1])('ages a job against its Hub when client time is offset by %i hour', direction => {
    const hub = new HubClock()
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100)
    const wall = vi.spyOn(Date, 'now').mockReturnValue(10_000 + direction * 3_600_000)
    try {
        hub.observe(10_000)
        expect(isAttachedJobStale({ heartbeatAt: 10_000 }, hub.now())).toBe(false)
        monotonic.mockReturnValue(100 + 16 * 60_000)
        expect(isAttachedJobStale({ heartbeatAt: 10_000 }, hub.now())).toBe(true)
    } finally { wall.mockRestore(); monotonic.mockRestore() }
})

it('accepts a backward Hub correction but rejects the response to an older in-flight request', () => {
    const hub = new HubClock()
    const perf = vi.spyOn(performance, 'now').mockReturnValue(1)
    try {
        hub.observe(4_000_000)
        const olderRequest = hub.beginSample()
        hub.observe(1000)
        hub.observe(4_000_100, olderRequest)
        expect(hub.now()).toBe(1000)
        expect(isAttachedJobStale({ heartbeatAt: 1000 }, hub.now())).toBe(false)
    } finally { perf.mockRestore() }
})
