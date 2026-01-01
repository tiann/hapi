import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'
import { commandRegistry } from '../registry'
import { buildHelpCard } from '../cards/helpCards'

export const helpCommand: CommandDefinition = {
    name: 'help',
    aliases: [],
    category: 'hapi',
    description: '显示帮助信息',
    usage: '/help [command]',
    args: [
        {
            name: 'command',
            type: 'string',
            required: false,
            description: '要查看帮助的命令名'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const commandName = args.positional[0]

        if (commandName) {
            const command = commandRegistry.get(commandName)
            if (!command) {
                return {
                    success: false,
                    error: `未知命令: ${commandName}\n使用 /help 查看所有可用命令`
                }
            }

            const argsHelp = command.args.length > 0
                ? command.args.map(arg => {
                    const required = arg.required ? '(必需)' : '(可选)'
                    const choices = arg.choices ? ` [${arg.choices.join('|')}]` : ''
                    return `  • ${arg.name} ${required}${choices}: ${arg.description}`
                }).join('\n')
                : '  无参数'

            return {
                success: true,
                message: [
                    `📖 **${command.name}**`,
                    '',
                    command.description,
                    '',
                    `**用法:** \`${command.usage}\``,
                    '',
                    '**参数:**',
                    argsHelp,
                    '',
                    command.aliases.length > 0 ? `**别名:** ${command.aliases.join(', ')}` : ''
                ].filter(Boolean).join('\n')
            }
        }

        const hapiCommands = commandRegistry.getByCategory('hapi')
        const card = buildHelpCard({ commands: hapiCommands })

        return {
            success: true,
            card
        }
    }
}

export const helpCommands = [helpCommand]
