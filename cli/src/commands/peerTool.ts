import chalk from 'chalk'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { isPeerToolsDisabled } from '@/modules/common/peerTools'
import {
    PEER_TOOL_DEFINITIONS,
    createPeerToolHandlers,
    isPeerToolName,
    type PeerToolResult,
} from '@/modules/pingPeer/peerToolDefinitions'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

const USAGE_EXIT_CODE = 2

const PEER_TOOL_NAMES = Object.keys(PEER_TOOL_DEFINITIONS)

class PeerToolUsageError extends Error {}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi peer-tool')} - Run a peer MCP tool from the command line

${chalk.bold('Usage:')}
  echo '<json-args>' | hapi peer-tool <${PEER_TOOL_NAMES.join('|')}>

${chalk.bold('Notes:')}
  Same input schema and result as the in-session MCP tool of the same name.
  Arguments are a JSON object on stdin (empty stdin = {}); the MCP tool result
  ({"content":[...],"isError":...}) is written as JSON to stdout.
  Exit 0 on success, 1 when the tool result has isError, 2 on usage errors
  (unknown tool, invalid JSON or arguments) or when HAPI_DISABLE_PEER_TOOLS is set.
  HAPI_SESSION_ID (set inside HAPI sessions) identifies the caller: it is
  excluded from list_peers, stamped as Parent by spawn_peer, and receives
  waitForReply replies (the process then stays alive until the reply is forwarded).

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
}

function parseJsonArgs(raw: string): unknown {
    if (!raw.trim()) return {}
    try {
        return JSON.parse(raw)
    } catch (error) {
        throw new PeerToolUsageError(`arguments on stdin must be JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
}

/**
 * Runs `hapi peer-tool <name>` with the given raw stdin. Returns null when
 * help was printed; throws PeerToolUsageError on usage errors.
 */
export async function runPeerToolCommand(commandArgs: string[], readInput: () => Promise<string> = readStdin): Promise<PeerToolResult | null> {
    const [name, ...rest] = commandArgs
    if (name === '--help' || name === '-h') {
        showHelp()
        return null
    }
    if (!name) {
        throw new PeerToolUsageError(`missing tool name; usage: hapi peer-tool <${PEER_TOOL_NAMES.join('|')}>`)
    }
    if (rest.length > 0) {
        throw new PeerToolUsageError(`unexpected arg: ${rest[0]} (pass tool arguments as JSON on stdin)`)
    }
    if (!isPeerToolName(name)) {
        throw new PeerToolUsageError(`unknown peer tool '${name}' (expected ${PEER_TOOL_NAMES.join(', ')})`)
    }
    if (isPeerToolsDisabled()) {
        throw new PeerToolUsageError('peer session tools are disabled on this machine (HAPI_DISABLE_PEER_TOOLS is set)')
    }

    const parsed = PEER_TOOL_DEFINITIONS[name].inputSchema.safeParse(parseJsonArgs(await readInput()))
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')
        throw new PeerToolUsageError(`invalid arguments for ${name}: ${issues}`)
    }

    await initializeToken()

    const callerSessionId = process.env[HAPI_SESSION_ID_ENV]?.trim() || undefined
    const handlers = createPeerToolHandlers({
        callerSessionId,
        // Parent identity falls back to HAPI_SESSION_* env, like `hapi spawn-peer`.
        spawnContext: () => ({ requireParent: false }),
    })
    const handler = handlers[name] as (args: unknown) => Promise<PeerToolResult>
    return await handler(parsed.data)
}

export const peerToolCommand: CommandDefinition = {
    name: 'peer-tool',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        let result: PeerToolResult | null
        try {
            result = await runPeerToolCommand(commandArgs)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(chalk.red('hapi peer-tool:'), message)
            process.exit(error instanceof PeerToolUsageError ? USAGE_EXIT_CODE : 1)
        }
        if (!result) return
        process.stdout.write(JSON.stringify(result) + '\n')
        if (result.isError) {
            process.exitCode = 1
        }
    }
}
