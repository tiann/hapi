#!/usr/bin/env bun
// Demo: fire one real FCM payload of each severity to every registered
// device under a namespace, ~3s apart, so the operator can compare the
// four notification colors on phone and watch in a single sequence.
//
// Severities (matches hub/src/fcm/fcmNotificationChannel.ts assignments):
//   info     -> ready          -> blue/cyan accent
//   warning  -> permission     -> amber accent
//   success  -> task done      -> green accent
//   error    -> task failed    -> red accent
//
// Usage:
//   sudo --preserve-env=PATH bash -c 'set -a; source /home/heavygee/.hapi/hub.env; \
//     HAPI_DB=/home/heavygee/.hapi/hapi.db \
//     bun run /home/heavygee/coding/hapi/scripts/tooling/fcm-color-demo.mjs [namespace]'
//
// (sudo only required if the env file or DB is root-owned; on this host
//  we run the hub as the heavygee user, so plain bun also works once the
//  env vars are exported in the current shell.)

import path from 'node:path'
import os from 'node:os'

const driverRoot = path.resolve(import.meta.dir, '../../../hapi-driver')
const { FcmService } = await import(path.join(driverRoot, 'hub/src/fcm/fcmService.ts'))
const { resolveFcmConfig } = await import(path.join(driverRoot, 'hub/src/fcm/fcmConfig.ts'))
const { Store } = await import(path.join(driverRoot, 'hub/src/store/index.ts'))

const namespace = process.argv[2] ?? 'default'
const dbPath = process.env.HAPI_DB ?? path.join(os.homedir(), '.hapi', 'hapi.db')

const cfg = resolveFcmConfig()
if (!cfg) {
    console.error('[demo] FCM not configured. Set FCM_SERVICE_ACCOUNT_PATH / FCM_PROJECT_ID.')
    process.exit(1)
}
const store = new Store(dbPath)
const devices = store.fcm.getDevicesByNamespace(namespace)
console.log(`[demo] namespace=${namespace} project=${cfg.projectId} devices=${devices.length}`)
for (const d of devices) {
    console.log(`  ${d.platform.padEnd(5)} ${d.deviceId.slice(0, 12)}...`)
}
if (devices.length === 0) {
    console.error('[demo] no registered devices in this namespace; open the companion app first')
    process.exit(2)
}

const fcm = new FcmService(cfg.projectId, cfg.serviceAccount, store)

// Use a real-ish session URL so the watch tap behavior still works, but
// nothing in this script depends on a session existing.
const baseUrl = '/sessions/00000000-color-demo-0000-000000000000'

const cases = [
    {
        severity: 'info',
        type: 'ready',
        title: 'Color demo - INFO (blue)',
        body: 'Agent finished a turn. No action needed - this is the ambient ready color.'
    },
    {
        severity: 'warning',
        type: 'permission-request',
        title: 'Color demo - WARNING (amber)',
        body: 'Agent is asking permission. Tap to approve or deny - amber means decision pending.',
        requestId: 'demo-req-' + Date.now()
    },
    {
        severity: 'success',
        type: 'task-notification',
        title: 'Color demo - SUCCESS (green)',
        body: 'Background task finished cleanly. Green = good news, no action needed.'
    },
    {
        severity: 'error',
        type: 'task-notification',
        title: 'Color demo - ERROR (red)',
        body: 'Background task failed. Red = something needs your attention soon.'
    }
]

for (const c of cases) {
    const data = {
        type: c.type,
        sessionId: '00000000-color-demo-0000-000000000000',
        sessionName: 'Color demo',
        url: baseUrl,
        title: c.title,
        body: c.body,
        contractVersion: 'v1',
        severity: c.severity
    }
    if (c.requestId) data.requestId = c.requestId

    const result = await fcm.sendToNamespace(namespace, {
        title: c.title,
        body: c.body,
        tag: `color-demo-${c.severity}`,
        data
    })
    console.log(`[demo] severity=${c.severity.padEnd(7)} sent=${result.sent} failed=${result.failed}`)
    // Stagger so they land in stream as four distinct cards rather than
    // one overwriting another. Wear OS coalesces same-tag notifications
    // - we use distinct tags above so they all stay visible.
    await new Promise((r) => setTimeout(r, 3500))
}

store.close()
console.log('[demo] done. Check your phone pull-down and watch stream for four colored cards.')
