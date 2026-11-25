import { expect, it, vi } from 'vitest'
import { coalesceStopRequests } from './stopSessionRequests'

it('joins in-flight cleanup after a lost acknowledgement, then permits re-verification', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const stop = vi.fn(async () => { await gate; return 'stopped' })
    const request = coalesceStopRequests(stop)
    const first = request('session-a')
    const retry = request('session-a')
    expect(stop).toHaveBeenCalledTimes(1)
    release()
    expect(await Promise.all([first, retry])).toEqual(['stopped', 'stopped'])
    await request('session-a')
    expect(stop).toHaveBeenCalledTimes(2)
})

it('does not share stop evidence across PID generations and releases failed operations', async () => {
    const stop = vi.fn(async () => { throw new Error('unconfirmed') })
    const request = coalesceStopRequests(stop)
    const first = request('PID-100', { processStartMarker: 'old' }).catch(String)
    const second = request('PID-100', { processStartMarker: 'new' }).catch(String)
    await Promise.all([first, second])
    expect(stop).toHaveBeenCalledTimes(2)
    await request('PID-100', { processStartMarker: 'old' }).catch(String)
    expect(stop).toHaveBeenCalledTimes(3)
})
