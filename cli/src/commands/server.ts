import chalk from 'chalk'
import type { CommandDefinition, CommandContext } from './types'

function parseServerArgs(args: string[]): { host?: string; port?: string } {
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

export const serverCommand: CommandDefinition = {
    name: 'server',
    requiresRuntimeAssets: false,
    run: async (context: CommandContext) => {
        try {
            const { host, port } = parseServerArgs(context.commandArgs)

            if (host) {
                process.env.WEBAPP_HOST = host
            }
            if (port) {
                process.env.WEBAPP_PORT = port
            }
            await import('../../../server/src/index')
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
