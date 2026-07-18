import chalk from 'chalk'
import type { CommandDefinition, CommandContext } from './types'

export type HubArgs = {
    help: boolean
    host?: string
    port?: string
}

export function parseHubArgs(args: string[]): HubArgs {
    const result: HubArgs = { help: false }

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]
        if (arg === '--help' || arg === '-h') {
            result.help = true
        } else if (arg === '--relay' || arg === '--no-relay') {
            // The Hub entrypoint consumes these mutually-overriding flags from
            // process.argv. Recognize them here so every other option can be
            // rejected instead of silently ignored.
        } else if (arg === '--host' || arg === '--port') {
            const value = args[i + 1]
            if (!value || value.startsWith('--')) {
                throw new Error(`Missing value for hapi hub option: ${arg}`)
            }
            if (arg === '--host') result.host = value
            else result.port = value
            i += 1
        } else if (arg.startsWith('--host=')) {
            const value = arg.slice('--host='.length)
            if (!value) throw new Error('Missing value for hapi hub option: --host')
            result.host = value
        } else if (arg.startsWith('--port=')) {
            const value = arg.slice('--port='.length)
            if (!value) throw new Error('Missing value for hapi hub option: --port')
            result.port = value
        } else {
            throw new Error(`Unknown hapi hub option: ${arg}`)
        }
    }

    return result
}

function showHubHelp(): void {
    console.log(`
${chalk.bold('hapi hub')} - Start the bundled HAPI Hub

${chalk.bold('Usage:')}
  hapi hub [--host <host>] [--port <port>] [--relay | --no-relay]

${chalk.bold('Options:')}
  --host <host>   Listen address (for example 127.0.0.1 or 0.0.0.0)
  --port <port>   Listen port
  --relay         Enable the HAPI relay tunnel
  --no-relay      Disable the HAPI relay tunnel
  -h, --help      Show this help without starting Hub
`)
}

type LoadHub = () => Promise<unknown>
type PrepareRuntime = () => Promise<void>

export async function executeHubCommand(
    args: string[],
    loadHub: LoadHub = () => import('../../../hub/src/index'),
    prepareRuntime: PrepareRuntime = async () => {},
): Promise<void> {
    const { help, host, port } = parseHubArgs(args)
    if (help) {
        showHubHelp()
        return
    }

    await prepareRuntime()
    if (host) process.env.HAPI_LISTEN_HOST = host
    if (port) process.env.HAPI_LISTEN_PORT = port
    await loadHub()
}

async function prepareHubRuntime(): Promise<void> {
    const [{ ensureRuntimeAssets }, { logger }, { isBunCompiled }] = await Promise.all([
        import('@/runtime/assets'),
        import('@/ui/logger'),
        import('@/projectPath'),
    ])
    if (isBunCompiled()) process.env.DEV = 'false'
    await ensureRuntimeAssets()
    logger.debug('Starting hapi CLI with args: ', process.argv)
}

export const hubCommand: CommandDefinition = {
    name: 'hub',
    // Help must short-circuit before runtime initialization. Normal startup
    // performs the same preparation explicitly inside executeHubCommand.
    requiresRuntimeAssets: false,
    run: async (context: CommandContext) => {
        try {
            await executeHubCommand(context.commandArgs, undefined, prepareHubRuntime)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
