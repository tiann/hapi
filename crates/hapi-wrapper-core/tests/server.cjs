const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createRequire } = require('node:module')
const hubRequire = createRequire(require.resolve('../../../hub/package.json'))
const socketRequire = createRequire(hubRequire.resolve('socket.io'))
const { Server } = hubRequire('socket.io')

if (process.argv[2] === 'parser') {
    const { Decoder, Encoder } = socketRequire('socket.io-parser')
    const decoder = new Decoder()
    const encoder = new Encoder()
    for (const wire of JSON.parse(require('node:fs').readFileSync(0, 'utf8'))) {
        decoder.once('decoded', packet => assert.equal(encoder.encode(packet)[0], wire))
        decoder.add(wire)
    }
    const reserved = ['connect', 'connect_error', 'disconnect', 'disconnecting', 'newListener', 'removeListener']
    for (const name of [3.5, -1, '', '😀,123', ...reserved]) {
        const wire = encoder.encode({ type: 2, nsp: '/cli', id: 5, data: [name, true] })[0]
        if (reserved.includes(name)) assert.throws(() => decoder.add(wire), /invalid payload/)
        else decoder.add(wire)
        console.log(JSON.stringify({ wire, name, valid: !reserved.includes(name) }))
    }
} else {
    const http = createServer()
    const io = new Server(http, { transports: ['websocket'] })
    const received = []
    let connections = 0
    io.of('/cli').use((socket, next) => {
        if (socket.handshake.auth.token === 'rejected') return next(new Error('Invalid token'))
        assert.deepEqual(socket.handshake.auth, { token: 'fixture-token', clientType: 'session-scoped', sessionId: 's' })
        assert.equal(socket.handshake.headers['x-fixture'], 'upgrade')
        next()
    }).on('connection', socket => {
        connections++
        socket.on('title', ack => ack({ title: '😀'.slice(0, 1) }))
        socket.on('echo', (...args) => args.pop()(...args))
        socket.on('record', value => received.push(value))
        socket.on('snapshot', ack => ack({ received, connections }))
        socket.on('drop', () => socket.conn.close())
        socket.on('end', () => socket.disconnect())
        socket.on('disconnect', reason => console.log(JSON.stringify({reason, received, connections})))
        const decimal = 51.248178375505404
        socket.emit('request', connections, decimal, (a, b, echoed) => {
            assert.equal(echoed, decimal)
            socket.emit('answered', a, b)
        })
    })
    http.listen(0, '127.0.0.1', () => console.log(http.address().port))
}
