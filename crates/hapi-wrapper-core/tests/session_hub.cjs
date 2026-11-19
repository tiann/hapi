const {createServer} = require('node:http')
const {createRequire} = require('node:module')
const {createInterface} = require('node:readline')
const {Server} = createRequire(require.resolve('../../../hub/package.json'))('socket.io')
const assert = require('node:assert/strict')
const requests = []
const emitted = []
const row = {
    id: 's', namespace: 'default', seq: 0, createdAt: 1, updatedAt: 1, active: false,
    activeAt: 0, metadataVersion: 1, agentStateVersion: 1, agentState: {},
    metadata: {host:'test',path:'/tmp'}, thinking:false, thinkingAt:0
}
let rows = []
let ackMode = 'success'
let connections=0
let sessionSummaryContract
let holdPageAfter
let failPageAfter
let releasePage
let releaseRefresh
let holdRefresh=false
let steerReply=true
let forceId
let socket
let pings = true
let malformed = false
async function handleRest(req,res) {
    const path = new URL(req.url, 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    requests.push({path:path.pathname, query:path.search, body})
    res.setHeader('content-type','application/json')
    if (path.pathname === '/session-started') {
        assert.equal(req.headers.authorization,undefined)
        assert.equal(req.headers['x-fixture'],undefined)
        res.end('{}')
        return
    }
    assert.equal(req.headers.authorization,'Bearer token')
    assert.equal(req.headers['x-fixture'],'extra')
    assert.equal(req.headers['content-type'],'application/json')
    if (path.pathname.endsWith('/messages')) {
        const after = Number(path.searchParams.get('afterSeq'))
        if (after === holdPageAfter) {
            holdPageAfter = undefined
            await new Promise(resolve => { releasePage = resolve })
        }
        if (after === failPageAfter) {
            failPageAfter = undefined
            res.writeHead(503).end()
            return
        }
        res.end(JSON.stringify({messages:rows.filter(r => r.seq > Number(path.searchParams.get('afterSeq'))).slice(0,200)}))
    } else if (path.pathname === '/cli/machines') {
        res.end(JSON.stringify({machine:{...row,id:body.id,metadata:body.metadata,runnerState:null,runnerStateVersion:0}}))
    } else {
        if (body) Object.assign(row,{id:forceId || body.id || 's', metadata:body.metadata, agentState:body.agentState})
        if (!body && holdRefresh) {
            holdRefresh=false
            await new Promise(resolve => {releaseRefresh=resolve})
        }
        const session=malformed==='missing' ? {metadataVersion:99} : malformed ? {metadataVersion:99,metadata:{bad:true}} : row
        res.end(JSON.stringify({session,sessionSummaryContract}))
    }
}
const http = createServer(handleRest)
const io = new Server(http,{transports:['websocket']})
io.of('/cli').on('connection', s => {
    connections++
    socket = s
    assert.deepEqual(s.handshake.auth,{token:'token',clientType:'session-scoped',sessionId:row.id})
    s.onAny((event, payload) => emitted.push({event,payload:typeof payload==='function'?null:payload}))
    s.on('ping', ack => { if(pings) ack() })
    s.on('messages-steer-state', (_,ack) => ack({ok:steerReply}))
    for (const [event,key] of [['update-metadata','metadata'],['update-state','agentState']]) {
        s.on(event,(payload,ack) => {
            if (ackMode==='hold') return
            if (ackMode==='drop') { ackMode='success'; s.conn.close(); return }
            const versionKey = key+'Version'
            const archived = ackMode.startsWith('archive-')
            const mismatch = ackMode==='archive-mismatch' || payload.expectedVersion!==row[versionKey]
            if (archived) row[key]={...row[key],lifecycleState:'archived',archivedBy:'hub'}
            else if (!mismatch) row[key]=payload[key]
            if (!mismatch || archived) row[versionKey]++
            ack({result:mismatch?'version-mismatch':'success',version:row[versionKey],[key]:row[key]})
        })
    }
})
createInterface({input:process.stdin}).on('line', async line => {
    const cmd=JSON.parse(line)
    let result=true
    if (cmd.op === 'startTls') {
        const pem = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/localhost-test-server.pem'))
        const https = require('node:https').createServer({ key: pem, cert: pem }, handleRest)
        await new Promise(resolve => https.listen(0, '127.0.0.1', resolve))
        result = https.address().port
    }
    if (cmd.op==='snapshot') result={requests,emitted,row,connections,refreshPending:!!releaseRefresh,pagePending:!!releasePage}
    if (cmd.op==='contract') sessionSummaryContract=cmd.value
    if (cmd.op==='holdPage') holdPageAfter=cmd.value
    if (cmd.op==='failPage') failPageAfter=cmd.value
    if (cmd.op==='releasePage') {releasePage?.(); releasePage=undefined}
    if (cmd.op==='holdRefresh') holdRefresh=true
    if (cmd.op==='releaseRefresh') {releaseRefresh?.(); releaseRefresh=undefined}
    if (cmd.op==='steerReply') steerReply=cmd.value
    if (cmd.op==='forceId') forceId=cmd.value
    if (cmd.op==='rows') rows=cmd.value
    if (cmd.op==='ackMode') ackMode=cmd.value
    if (cmd.op==='metadata') Object.assign(row,cmd.value)
    if (cmd.op==='malformed') malformed=cmd.value
    if (cmd.op==='ping') pings=cmd.value
    if (cmd.op==='disconnect') socket.disconnect()
    if (cmd.op==='drop') socket.conn.close()
    if (cmd.op==='update') socket.emit('update',{body:cmd.value})
    if (cmd.op==='ack') result=await socket.timeout(3000).emitWithAck('update',{body:cmd.value})
    if (cmd.op==='rpc') result=await socket.timeout(3000).emitWithAck('rpc-request',cmd.value)
    console.log(JSON.stringify(result ?? null))
})
http.listen(0,'127.0.0.1',()=>console.log(http.address().port))
