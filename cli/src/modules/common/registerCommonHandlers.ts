import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerBashHandlers } from './handlers/bash'
import { registerDirectoryHandlers } from './handlers/directories'
import { registerDifftasticHandlers } from './handlers/difftastic'
import { registerFileHandlers } from './handlers/files'
import { registerGitHandlers } from './gitHandlers'
import { registerRipgrepHandlers } from './handlers/ripgrep'
import { registerSlashCommandHandlers } from './handlers/slashCommands'

export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    registerBashHandlers(rpcHandlerManager, workingDirectory)
    registerFileHandlers(rpcHandlerManager, workingDirectory)
    registerDirectoryHandlers(rpcHandlerManager, workingDirectory)
    registerRipgrepHandlers(rpcHandlerManager, workingDirectory)
    registerDifftasticHandlers(rpcHandlerManager, workingDirectory)
    registerSlashCommandHandlers(rpcHandlerManager)
    registerGitHandlers(rpcHandlerManager, workingDirectory)
}
