import { sessionCommands } from './sessions'
import { permissionCommands } from './permission'
import { historyCommands } from './history'
import { helpCommands } from './help'
import { bindCommands } from './bind'
import { summaryCommands } from './summary'
import { sessionManageCommands } from './sessionManage'
import { notifyCommands } from './notify'
import { systemCommands } from './system'
import type { CommandDefinition } from '../types'

export const hapiCommands: CommandDefinition[] = [
    ...sessionCommands,
    ...permissionCommands,
    ...historyCommands,
    ...helpCommands,
    ...bindCommands,
    ...summaryCommands,
    ...sessionManageCommands,
    ...notifyCommands,
    ...systemCommands,
]

export { isNotifyEnabled } from './notify'
