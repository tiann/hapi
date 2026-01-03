import { ApiClient } from '../api/api'
import { readSettings } from '../persistence'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import packageJson from '../../package.json'
import { configuration } from '@/configuration'
import { runtimePath } from '@/projectPath'

async function main() {
  const client = await ApiClient.create()
  const settings = await readSettings()
  const machineId = settings.machineId || randomUUID()
  await client.getOrCreateMachine({
    machineId,
    metadata: {
      host: os.hostname(),
      platform: os.platform(),
      happyCliVersion: packageJson.version,
      homeDir: os.homedir(),
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: runtimePath()
    }
  })
  const session = await client.getOrCreateSession({
    tag: randomUUID(),
    metadata: {
      path: process.cwd(),
      host: os.hostname(),
      version: packageJson.version,
      os: os.platform(),
      machineId,
      homeDir: os.homedir(),
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: runtimePath(),
      happyToolsDir: resolve(runtimePath(), 'tools', 'unpacked')
    },
    state: null
  })
  const sc = client.sessionSyncClient(session)
  sc.onUserMessage((m) => {
    console.log('[user]', typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  })
  sc.on('message', (m) => {
    console.log('[message]', JSON.stringify(m))
  })
  sc.sendUserMessage('/status', { messageType: 'command' })
  await new Promise((r) => setTimeout(r, 3000))
  sc.sendSessionDeath()
}

main()
