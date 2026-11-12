import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listSkills, type ListSkillsRequest, type ListSkillsResponse } from '../skills'
import { getErrorMessage, rpcError } from '../rpcResponses'

export interface SkillsHandlerOptions {
    /**
     * Resolves the isolated berry data dir for the serving session
     * (`<hapiHome>/berry-data/<rowId>` — the BERRY_AGENT_DATA_DIR its
     * spawned berry child runs on). Consumed only for berry-flavor
     * requests: berry's own user-skills layer is `<dataDir>/skills`, so
     * the listing must read that tree instead of the interactive
     * `~/.berry-agent` the CLI process would otherwise fall back to.
     */
    resolveBerryDataDir?: () => string | null
}

export function registerSkillsHandlers(
    rpcHandlerManager: RpcHandlerManager,
    workingDirectory: string,
    options: SkillsHandlerOptions = {}
): void {
    rpcHandlerManager.registerHandler<ListSkillsRequest, ListSkillsResponse>(RPC_METHODS.ListSkills, async (request) => {
        logger.debug('List skills request')

        try {
            const skills = await listSkills(workingDirectory, {
                flavor: request.flavor,
                // skills.ts only consults this for the berry flavor; other
                // flavors ignore it.
                berryDataDir: options.resolveBerryDataDir?.() ?? undefined
            })
            return { success: true, skills }
        } catch (error) {
            logger.debug('Failed to list skills:', error)
            return rpcError(getErrorMessage(error, 'Failed to list skills'))
        }
    })
}
