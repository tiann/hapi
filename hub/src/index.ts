import { ensureLoopbackProxyBypass } from '@hapi/protocol/net'
import { startHub } from './startHub'

async function main() {
    // Keep loopback traffic direct when fetch/web-push use an env proxy.
    ensureLoopbackProxyBypass()
    const hub = await startHub()

    const shutdown = async () => {
        console.log('\nShutting down...')
        await hub.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep process running
    await new Promise(() => {})
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
