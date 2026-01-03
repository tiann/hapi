export type CommandContext = {
    args: string[]
    subcommand?: string
    commandArgs: string[]
}

export type CommandDefinition = {
    name: string
    requiresRuntimeAssets: boolean
    run: (context: CommandContext) => Promise<void>
}
