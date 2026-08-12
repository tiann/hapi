// Standalone child process for runnerLifecycle.process.test.ts.
//
// Runs createRunnerLifecycle().registerProcessHandlers() in a *real*,
// separately-spawned OS process — the only way to prove the SIGHUP handler
// actually replaces the kernel's default terminate-on-SIGHUP action (a
// same-process `process.emit('SIGHUP')` in a unit test only proves the
// listener ran, not that it beat the default disposition).
//
// Uses fs.writeSync(1, ...) instead of console.log: stdout is a pipe when
// spawned from the test, and Node/Bun buffer pipe writes asynchronously —
// a subsequent process.exit() (the HAPI_EXIT_ON_HANGUP=1 path) can truncate
// anything still in flight. Synchronous writes make every line observable
// to the parent before exit.
import fs from 'node:fs'
import { createRunnerLifecycle } from '../runnerLifecycle'

const session = {
    updateMetadata: (fn: (m: Record<string, unknown>) => Record<string, unknown>) => {
        const next = fn({})
        fs.writeSync(1, `EVENT updateMetadata ${JSON.stringify(next)}\n`)
    },
    sendSessionDeath: (reason: string) => {
        fs.writeSync(1, `EVENT sendSessionDeath ${reason}\n`)
    },
    flush: async () => true,
    close: async () => {
        fs.writeSync(1, 'EVENT close\n')
    }
} as unknown as Parameters<typeof createRunnerLifecycle>[0]['session']

const lifecycle = createRunnerLifecycle({ session, logTag: 'child' })
// SIGHUP survival is opt-in — this fixture exercises the opted-in flavor.
// See runnerLifecycleProcessChildNoOptIn.ts for the un-opted-in sibling.
lifecycle.registerProcessHandlers({ surviveTerminalHangup: true })

fs.writeSync(1, 'READY\n')

// Keep the event loop alive so the parent test can observe "still running"
// well after SIGHUP — without this the process would exit on its own once
// there is nothing left to do, which would make the survival assertion
// meaningless.
setInterval(() => {}, 1000)
