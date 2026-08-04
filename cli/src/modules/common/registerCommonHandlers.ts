import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerAgyModelHandlers } from './handlers/agyModels'
import { registerBashHandlers } from './handlers/bash'
import { registerCodexModelHandlers } from './handlers/codexModels'
import { registerCursorModelHandlers } from './handlers/cursorModels'
import { registerOpencodeModelHandlers } from './handlers/opencodeModels'
import { registerGrokModelHandlers } from './handlers/grokModels'
import { registerCopilotModelHandlers } from './handlers/copilotModels'
import { registerDirectoryHandlers } from './handlers/directories'
import { registerDifftasticHandlers } from './handlers/difftastic'
import { registerFileHandlers } from './handlers/files'
import { registerGitHandlers } from './handlers/git'
import { registerRipgrepHandlers } from './handlers/ripgrep'
import { registerSlashCommandHandlers } from './handlers/slashCommands'
import { registerSkillsHandlers } from './handlers/skills'
import { registerUploadHandlers } from './handlers/uploads'

export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    registerAgyModelHandlers(rpcHandlerManager)
    registerBashHandlers(rpcHandlerManager, workingDirectory)
    registerCodexModelHandlers(rpcHandlerManager)
    registerCursorModelHandlers(rpcHandlerManager)
    registerOpencodeModelHandlers(rpcHandlerManager)
    registerGrokModelHandlers(rpcHandlerManager)
    registerCopilotModelHandlers(rpcHandlerManager)
    registerFileHandlers(rpcHandlerManager, workingDirectory)
    registerDirectoryHandlers(rpcHandlerManager, workingDirectory)
    registerRipgrepHandlers(rpcHandlerManager, workingDirectory)
    registerDifftasticHandlers(rpcHandlerManager, workingDirectory)
    registerSlashCommandHandlers(rpcHandlerManager, workingDirectory)
    registerSkillsHandlers(rpcHandlerManager, workingDirectory)
    registerGitHandlers(rpcHandlerManager, workingDirectory)
    registerUploadHandlers(rpcHandlerManager)
}
