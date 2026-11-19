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
    return normalizeDecryptedMessage({ id: 'row-' + i, seq: i + 1, localId: localId ?? null, createdAt: createdAt ?? storedAt, content: message })
})
process.stdout.write(JSON.stringify(decoded))
