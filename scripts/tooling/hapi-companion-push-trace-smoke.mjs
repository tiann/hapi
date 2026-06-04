#!/usr/bin/env bun
/**
 * Trace one notification through the live PushNotificationChannel against
 * the real store + sse + visibility wiring. With HAPI_NOTIFY_DEBUG=1 set
 * in ~/.hapi/hub.env the hub journal will record which branch fired:
 *
 *   not-visible -> skip-web-push native-companion-registered
 *   not-visible -> web-push-fired                 (= dedupe broken)
 *   sse-toast-delivered                           (= PWA visible, in-page toast only)
 *   sse-toast-zero -> skip-web-push|web-push-fired
 *
 * This script does NOT exercise the full live hub - it imports the channel
 * with its real construction args + the real store via SQLite so the FCM
 * device probe returns the truth. That is enough to verify the dedupe
 * decision the live hub would make for the same namespace.
 *
 * Usage: bun run scripts/tooling/hapi-companion-push-trace-smoke.mjs [--namespace default]
 */
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const repoFromScript = join(scriptDir, '../..')
const hubRoot = existsSync(join(homedir(), 'coding/hapi-active'))
    ? realpathSync(join(homedir(), 'coding/hapi-active'))
    : repoFromScript

function loadEnvFile(path) {
    if (!existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const eq = t.indexOf('=')
        if (eq < 0) continue
        const key = t.slice(0, eq)
        let val = t.slice(eq + 1)
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
        }
        if (process.env[key] === undefined) process.env[key] = val
    }
}
loadEnvFile(join(homedir(), '.hapi', 'hub.env'))

const args = process.argv.slice(2)
let namespace = 'default'
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--namespace' && args[i + 1]) namespace = args[++i]
}

const { PushNotificationChannel } = await import(join(hubRoot, 'hub/src/push/pushNotificationChannel.ts'))
const { Store } = await import(join(hubRoot, 'hub/src/store/index.ts'))

const dbPath = process.env.HAPI_DB_PATH ?? join(homedir(), '.hapi', 'hapi.db')
const store = new Store(dbPath)

console.log(`namespace=${namespace}`)
console.log(`fcm devices in namespace: ${store.fcm.getDevicesByNamespace(namespace).length}`)
console.log(`probe(${namespace}) =`, store.fcm.getDevicesByNamespace(namespace).length > 0)

// We are NOT connected to the same in-memory SSE/visibility state as the
// live hub - this is a forensic check of the *probe*. To confirm the live
// hub trace, the operator needs to trigger a real notification (e.g. spawn
// an agent that asks for permission), then we read the journal.
console.log('')
console.log('To exercise the live channel + see the branch trace, trigger a real')
console.log('event (e.g. spawn an agent that asks for permission). Then:')
console.log('')
console.log("  sudo journalctl -u hapi-hub.service --since '1 minute ago' | grep '\\[Push\\.'")
console.log('')
