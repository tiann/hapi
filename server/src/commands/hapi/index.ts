import { sessionCommands } from './sessions'
import { permissionCommands } from './permission'
import { historyCommands } from './history'
import { helpCommands } from './help'
import type { CommandDefinition } from '../types'

export const hapiCommands: CommandDefinition[] = [
    ...sessionCommands,
    ...permissionCommands,
    ...historyCommands,
    ...helpCommands,
]
