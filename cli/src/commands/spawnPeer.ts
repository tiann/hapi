import { initializeToken } from '@/ui/tokenInit'
import { SpawnPeerInputSchema } from '@/modules/common/spawnPeerTool'
import { spawnPeer } from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

export const spawnPeerCommand: CommandDefinition = {
    name: 'spawn-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.length === 1 && ['--help', '-h'].includes(commandArgs[0]!)) {
            console.log('Usage: hapi spawn-peer \'{"message":"Review the change","agent":"codex"}\'\nPass one JSON object. All New Chat options are supported; omit options to inherit shared preferences, or use null for native defaults. Uses HAPI_SESSION_ID as the parent when run inside a chat. Uncertain creation or delivery must be inspected before retrying.')
            return
        }
        if (commandArgs.length !== 1) throw new Error('Expected one JSON object; see hapi spawn-peer --help')
        const input = SpawnPeerInputSchema.parse(JSON.parse(commandArgs[0]!))
        await initializeToken()
        console.log(JSON.stringify(await spawnPeer(input, { currentSessionId: process.env.HAPI_SESSION_ID })))
    }
}
