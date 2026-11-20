import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { ApiSessionClient, IncomingMessageFilter } from '../../../cli/src/api/apiSession'

const transport = vi.hoisted(() => ({ ack: vi.fn() }))
vi.mock('socket.io-client', () => ({
    io: () => ({ connected: true, on() {}, connect() {}, disconnect() {}, timeout() { return this }, emitWithAck: transport.ack })
}))
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers() {} }))

it('records the TS filter and CAS results for the shared seeded inputs', async () => {
    const vectors = JSON.parse(readFileSync(process.env.HAPI_VECTOR_INPUT!, 'utf8'))
    const results = []
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
        for (const {capacity, stream, plan} of vectors) {
            const filter = new IncomingMessageFilter(capacity)
            const decisions = stream.map(([id, seq, rewind]) => {
                if (rewind != null) filter.rewindCursor(rewind)
                return [filter.accept({ id: id == null ? null : String(id), seq }), filter.cursorSeq()]
            })
            const metadata = {host:'fixture', path:'/tmp', name:''}
            const client = new ApiSessionClient('fixture', {
                id:'s', metadata, metadataVersion:0, agentState:null, agentStateVersion:0
            } as ConstructorParameters<typeof ApiSessionClient>[1])
            const outcomes = plan.flatMap(([failures]) => [...failures, null])
            let version = 0
            let name = ''
            transport.ack.mockImplementation(async (event, payload) => {
                expect(event).toBe('update-metadata')
                expect(payload.expectedVersion).toBe(version)
                const outcome = outcomes.shift()
                if (outcome === 1) return {result:'error'}
                if (outcome === 2) return {result:'success', version:'invalid'}
                if (outcome === 0) name += 'r'
                else name = payload.metadata.name
                return {result:outcome === 0 ? 'version-mismatch' : 'success', version:++version, metadata:{...metadata, name}}
            })
            for (const [,delta] of plan) client.updateMetadata(m => ({...m, name:m.name + String(delta)}))
            expect(await client.flushMetadata()).toBe(true)
            expect(outcomes).toHaveLength(0)
            results.push({decisions, version, name:client.getMetadata()?.name})
            client.close()
        }
        writeFileSync(process.env.HAPI_VECTOR_OUTPUT!, JSON.stringify(results))
    } finally {
        random.mockRestore()
    }
}, 15000)
