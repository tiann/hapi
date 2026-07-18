import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { RUNNER_CONTROL_BODY_LIMIT_BYTES, startRunnerControlServer } from './controlServer'

const malformedContentTypes = [
  ['tab suffix', 'Content-Type: application/json\ta'],
  ['leading space', 'Content-Type:  application/json'],
] as const

async function sendRawHttp(args: {
  port: number
  path: string
  contentTypeHeader: string
  body: string
  sendBody?: boolean
}): Promise<Buffer> {
  const requestHeaders = [
    `POST ${args.path} HTTP/1.1`,
    'Host: 127.0.0.1',
    args.contentTypeHeader,
    `Content-Length: ${Buffer.byteLength(args.body)}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n')
  const request = requestHeaders + (args.sendBody === false ? '' : args.body)

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = createConnection({ host: '127.0.0.1', port: args.port })
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw HTTP request timed out')))
    socket.on('connect', () => {
      if (args.sendBody === false) {
        socket.write(request)
        return
      }
      socket.end(request)
    })
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    socket.on('end', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

function responseStatus(rawResponse: Buffer): number {
  const statusLine = rawResponse.subarray(0, rawResponse.indexOf('\r\n')).toString('latin1')
  const match = /^HTTP\/1\.1 (\d{3}) /.exec(statusLine)
  if (!match) throw new Error(`invalid raw HTTP response: ${rawResponse.toString('hex')}`)
  return Number(match[1])
}

async function startContentSchemaCanary() {
  const app = fastify({ logger: false })
  let handlerCalls = 0
  app.post('/canary', {
    schema: {
      body: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['requiredField'],
              properties: { requiredField: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async () => {
    handlerCalls += 1
    return { ok: true }
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  return {
    port: Number(new URL(address).port),
    handlerCalls: () => handlerCalls,
    stop: () => app.close(),
  }
}

async function startHapiControlServer(
  onNativeIdentity: () => void,
  querySpawnSession: Parameters<typeof startRunnerControlServer>[0]['querySpawnSession'] = async () => ({
    type: 'error' as const,
    errorMessage: 'unused',
  }),
) {
  return await startRunnerControlServer({
    getChildren: () => [],
    stopSession: async () => false,
    spawnSession: async () => ({ type: 'error' as const, errorMessage: 'unused' }),
    querySpawnSession,
    requestShutdown: () => undefined,
    onHappySessionWebhook: () => undefined,
    onManagedOutcome: async () => ({ acknowledged: false }),
    onNativeIdentity: async () => {
      onNativeIdentity()
      return { acknowledged: true }
    },
  })
}

describe('Runner control request boundaries', () => {
  for (const [label, contentTypeHeader] of malformedContentTypes) {
    it(`rejects the official ${label} Content-Type bypass before a content-schema handler`, async () => {
      const canary = await startContentSchemaCanary()
      try {
        const rawResponse = await sendRawHttp({
          port: canary.port,
          path: '/canary',
          contentTypeHeader,
          body: '{}',
        })
        const status = responseStatus(rawResponse)

        expect(status < 200 || status >= 300, `raw=${rawResponse.toString('hex')}`).toBe(true)
        expect(canary.handlerCalls(), `raw=${rawResponse.toString('hex')}`).toBe(0)
      } finally {
        await canary.stop()
      }
    })

    it(`keeps the real HAPI native-identity handler closed for ${label} Content-Type`, async () => {
      let nativeIdentityCalls = 0
      const server = await startHapiControlServer(() => {
        nativeIdentityCalls += 1
      })
      try {
        const rawResponse = await sendRawHttp({
          port: server.port,
          path: '/native-identity',
          contentTypeHeader,
          body: '{}',
        })
        const status = responseStatus(rawResponse)

        expect(status < 200 || status >= 300, `raw=${rawResponse.toString('hex')}`).toBe(true)
        expect(nativeIdentityCalls, `raw=${rawResponse.toString('hex')}`).toBe(0)
      } finally {
        await server.stop()
      }
    })
  }

  it('returns 413 for a real HAPI control body over one MiB', async () => {
    let nativeIdentityCalls = 0
    const server = await startHapiControlServer(() => {
      nativeIdentityCalls += 1
    })
    try {
      const bodyWithoutPadding = JSON.stringify({
        launchNonce: '53ea731c-4d67-4d19-bd6f-158859c5fa08',
        pid: 1,
        nativeResumeId: 'resume-1',
        resumeProfileFingerprint: 'a'.repeat(64),
        padding: '',
      })
      const body = JSON.stringify({
        launchNonce: '53ea731c-4d67-4d19-bd6f-158859c5fa08',
        pid: 1,
        nativeResumeId: 'resume-1',
        resumeProfileFingerprint: 'a'.repeat(64),
        padding: 'x'.repeat(RUNNER_CONTROL_BODY_LIMIT_BYTES + 1 - Buffer.byteLength(bodyWithoutPadding)),
      })
      expect(Buffer.byteLength(body)).toBe(RUNNER_CONTROL_BODY_LIMIT_BYTES + 1)
      const rawResponse = await sendRawHttp({
        port: server.port,
        path: '/native-identity',
        contentTypeHeader: 'Content-Type: application/json',
        body,
        sendBody: false,
      })

      expect(responseStatus(rawResponse), `raw=${rawResponse.toString('hex')}`).toBe(413)
      expect(nativeIdentityCalls).toBe(0)
    } finally {
      await server.stop()
    }
  })

  it('configures the one MiB HAPI control limit explicitly', async () => {
    const source = await readFile(new URL('./controlServer.ts', import.meta.url), 'utf8')
    expect(source).toContain('bodyLimit: RUNNER_CONTROL_BODY_LIMIT_BYTES')
  })

  it('serializes a typed spawn operation conflict at the control boundary', async () => {
    const spawnRequestId = 'abababab-abab-4bab-8bab-abababababab'
    const server = await startHapiControlServer(
      () => undefined,
      async () => ({ type: 'conflict', spawnRequestId }),
    )
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/spawn-session-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spawnRequestId }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ type: 'conflict', spawnRequestId })
    } finally {
      await server.stop()
    }
  })
})
