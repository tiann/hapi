import { describe, expect, it } from 'vitest'
import { runLocalRemoteSession } from './loopBase'

describe('runLocalRemoteSession', () => {
  it('awaits managed native identity ownership before starting a provider launcher', async () => {
    const events: string[] = []
    let acknowledge!: () => void
    const barrier = new Promise<void>((resolve) => { acknowledge = resolve })
    const session = {
      waitForNativeIdentity: async () => { events.push('wait'); await barrier; events.push('ack') },
      onModeChange: () => undefined
    }
    const running = runLocalRemoteSession({
      session: session as never,
      startingMode: 'local',
      logTag: 'test',
      runLocal: async () => { events.push('launch'); return 'exit' },
      runRemote: async () => 'exit'
    })

    await Promise.resolve()
    expect(events).toEqual(['wait'])
    acknowledge()
    await running
    expect(events).toEqual(['wait', 'ack', 'launch'])
  })
})
