import chalk from 'chalk'
import type { CommandDefinition, CommandContext } from './types'
import packageJson from '../../package.json'

function parseHubArgs(args: string[]): { host?: string; port?: string } {
    const result: { host?: string; port?: string } = {}

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--host' && i + 1 < args.length) {
            result.host = args[++i]
        } else if (arg === '--port' && i + 1 < args.length) {
            result.port = args[++i]
        } else if (arg.startsWith('--host=')) {
            result.host = arg.slice('--host='.length)
        } else if (arg.startsWith('--port=')) {
            result.port = arg.slice('--port='.length)
        }
    }

    return result
}

export const hubCommand: CommandDefinition = {
    name: 'hub',
    requiresRuntimeAssets: true,
    run: async (context: CommandContext) => {
        try {
            const { host, port } = parseHubArgs(context.commandArgs)

            if (host) {
                process.env.HAPI_LISTEN_HOST = host
            }
            if (port) {
                process.env.HAPI_LISTEN_PORT = port
            }
            const { startHub } = await import('hapi-hub/startHub')
            const hub = await startHub({
                args: context.commandArgs,
                cliVersion: packageJson.version,
            })
            let shuttingDown = false
            const shutdown = async () => {
                if (shuttingDown) {
                    return
                }
                shuttingDown = true
                process.off('SIGINT', shutdown)
                process.off('SIGTERM', shutdown)
                console.log('\nShutting down...')
                await hub.stop()
                process.exit(0)
            }
            process.on('SIGINT', shutdown)
            process.on('SIGTERM', shutdown)
            await new Promise(() => {})
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
