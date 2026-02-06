import { readFile, writeFile } from 'node:fs/promises'

const httpJsonPath = 'hub_go/test/recordings/http/http-recordings.json'
const sseJsonPath = 'hub_go/test/recordings/sse/sse-events.json'
const httpOut = 'hub_go/test/contracts/http-recordings.ts'
const sseOut = 'hub_go/test/contracts/sse-recordings.ts'

async function syncHttp(): Promise<void> {
    const raw = await readFile(httpJsonPath, 'utf8')
    const data = JSON.parse(raw)
    const content = `export type HttpRecording = {
    method: string
    path: string
    request: {
        headers: Record<string, string>
        body?: unknown
    }
    response: {
        status: number
        headers: Record<string, string>
        body: unknown
    }
}

export const httpRecordings: HttpRecording[] = ${JSON.stringify(data, null, 4)}
`
    await writeFile(httpOut, content)
}

async function syncSse(): Promise<void> {
    const raw = await readFile(sseJsonPath, 'utf8')
    const data = JSON.parse(raw)
    const content = `export type SSERecording = {
    type?: string
    [key: string]: unknown
}

export const sseRecordings: SSERecording[] = ${JSON.stringify(data, null, 4)}
`
    await writeFile(sseOut, content)
}

async function main(): Promise<void> {
    await syncHttp()
    await syncSse()
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
