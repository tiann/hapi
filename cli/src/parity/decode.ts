import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Row } from './fakeHub'

const modulePath = resolve(import.meta.dir, '../../../web/src/chat/normalize.ts')
const { normalizeDecryptedMessage } = await import(modulePath)
const rows: Row[] = JSON.parse(readFileSync(0, 'utf8'))
let storedAt = 1
const decoded = rows.filter(row => row.event === 'message').map((row, i) => {
    const { localId, createdAt, message } = row.args[0] as { localId?: string; createdAt?: number; message: unknown }
    storedAt = Math.max(storedAt, createdAt ?? 1)
    const messageTime = createdAt ?? storedAt
    const result = normalizeDecryptedMessage({ id: 'row-' + i, seq: i + 1, localId: localId ?? null, createdAt: messageTime, content: message })
    if (result !== null) assert.equal(result.createdAt, messageTime, 'Decoded message creation time')
    return result
})
process.stdout.write(JSON.stringify(decoded))
