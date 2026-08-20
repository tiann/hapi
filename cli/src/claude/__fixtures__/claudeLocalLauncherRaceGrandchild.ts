// Standalone process used as the "claude" local child in
// claudeLocalLauncher.childExitsFirst.process.test.ts.
//
// Exits (code 0, signal null — the same "child observed the closed PTY and
// exited gracefully" shape a real claude process can take, see the clean-exit
// branch in claudeLocalLauncher.ts) as soon as it receives SIGHUP. It
// deliberately does not rely on the platform's default terminate-on-SIGHUP
// disposition, so the parent test harness can control exactly when this
// process exits relative to the "parent" fixture's own SIGHUP.
import fs from 'node:fs'

process.on('SIGHUP', () => {
    process.exit(0)
})

fs.writeSync(1, 'READY\n')

// Keep the event loop alive until SIGHUP arrives.
setInterval(() => {}, 1000)
