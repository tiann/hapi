import { createServer } from 'node:http'
import { body, listen } from '../fakeHub'

const connected = new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/session-started') res.statusCode = 404
    else if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') res.statusCode = 415
    else {
        console.log(JSON.stringify({ webhook: await body(req) }))
        await connected
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(res.statusCode === 200 ? JSON.stringify({ status: 'ok' }) : '{}')
})
console.log(JSON.stringify({ port: await listen(server) }))
