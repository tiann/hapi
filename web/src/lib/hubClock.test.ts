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
