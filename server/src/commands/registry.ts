import type { CommandCategory, CommandDefinition } from './types'

export class CommandRegistry {
    private commands: Map<string, CommandDefinition> = new Map()
    private aliases: Map<string, string> = new Map()

    register(command: CommandDefinition): void {
        this.commands.set(command.name, command)
        for (const alias of command.aliases) {
            this.aliases.set(alias, command.name)
        }
    }

    registerAll(commands: CommandDefinition[]): void {
        for (const cmd of commands) {
            this.register(cmd)
        }
    }

    get(nameOrAlias: string): CommandDefinition | undefined {
        const name = this.aliases.get(nameOrAlias) ?? nameOrAlias
        return this.commands.get(name)
    }

    getAll(): CommandDefinition[] {
        return Array.from(this.commands.values())
    }

    getByCategory(category: CommandCategory): CommandDefinition[] {
        return this.getAll().filter(cmd => cmd.category === category)
    }

    has(nameOrAlias: string): boolean {
        return this.get(nameOrAlias) !== undefined
    }
}

export const commandRegistry = new CommandRegistry()
