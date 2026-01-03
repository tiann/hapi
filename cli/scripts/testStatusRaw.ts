import axios from 'axios'
import { io } from 'socket.io-client'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

async function main() {
  const serverUrl = process.env.HAPI_SERVER_URL || 'http://127.0.0.1:8898'
  const token = process.env.CLI_API_TOKEN || ''
  if (!token) throw new Error('CLI_API_TOKEN required')

  const machineId = randomUUID()
  const createMachine = await axios.post(`${serverUrl}/cli/machines`, {
    id: machineId,
    metadata: { host: os.hostname() }
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 60000
  })

  const createSession = await axios.post(`${serverUrl}/cli/sessions`, {
    tag: randomUUID(),
    metadata: { path: process.cwd(), host: os.hostname(), machineId },
    agentState: null
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 60000
  })

  const session = createSession.data.session

  const socket = io(`${serverUrl}/cli`, {
    auth: { token, clientType: 'session-scoped', sessionId: session.id },
    path: '/socket.io/',
    transports: ['websocket']
  })

  socket.on('connect', () => {
    socket.emit('message', {
      sid: session.id,
      message: {
        role: 'user',
        content: { type: 'text', text: '/status' },
        meta: { sentFrom: 'cli', messageType: 'command' }
      }
    })
  })

  socket.on('update', (data: any) => {
    if (data?.body) console.log('[update]', JSON.stringify(data.body))
  })

  await new Promise((r) => setTimeout(r, 4000))
  socket.close()
}

main()
