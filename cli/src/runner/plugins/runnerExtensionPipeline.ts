import { delimiter, isAbsolute, relative, win32 } from 'node:path'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'
import type { HappyCliSpawnPlan } from '@/utils/spawnHappyCLI'
import type { PluginDiagnostic } from '@hapi/protocol/plugins'
import {
    RunnerCommandResolverProposalSchema,
    RunnerEnvironmentProposalSchema,
    RunnerResolvedSpawnOptionsSchema,
    RunnerSpawnContextSchema,
    RunnerSpawnHookProposalSchema,
    RunnerSpawnOptionsContextSchema,
    RunnerSpawnOptionsProviderProposalSchema,
    type RunnerCommandResolverProposal,
    type RunnerCommandResolverContribution,
    type RunnerEnvironmentProposal,
    type RunnerEnvironmentProviderContribution,
    type RunnerResolvedSpawnOptions,
    type RunnerSpawnOptionsAppliedEntry,
    type RunnerExtensionAuditEvent,
    type RunnerResolvedSpawnPlan,
    type RunnerSpawnOptionDefaults,
    type RunnerSpawnContext,
    type RunnerSpawnHookContribution,
    type RunnerSpawnHookProposal,
    type RunnerSpawnOptionsContext,
    type RunnerSpawnOptionsProviderContribution
} from '@hapi/protocol/plugins'

const DEFAULT_EXTENSION_TIMEOUT_MS = 1000
const PROTECTED_ENV_KEYS = new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_HOME',
    'HAPI_CLI_EXECUTABLE',
    'HAPI_INVOKED_CWD'
])
const ALLOWED_HAPI_SUBCOMMANDS = new Set(['claude', 'codex', 'cursor', 'gemini', 'kimi', 'opencode', 'agent-plugin'])
const REQUIRED_RUNNER_CONTROL_FLAGS = new Set(['--hapi-starting-mode', '--started-by'])

type MaybePromise<T> = T | Promise<T>
export type RunnerPluginDiagnosticSanitizer = (pluginId: string, value: unknown) => string

export type {
    RunnerCommandResolverContribution,
    RunnerEnvironmentProviderContribution,
    RunnerSpawnOptionsProviderContribution,
    RunnerSpawnHookContribution
} from '@hapi/protocol/plugins'

export type RegisteredRunnerContribution<T> = {
    pluginId: string
    id: string
    order: number
    priority: number
    contribution: T
}

export type RunnerSpawnBasePlan = {
    command: string
    args: string[]
    displayArgs: string[]
    mode: HappyCliSpawnPlan['mode']
    cwd: string
    env: NodeJS.ProcessEnv
}

export type ResolveRunnerSpawnPlanInput = {
    machineId: string
    options: SpawnSessionOptions
    agent: string
    basePlan: RunnerSpawnBasePlan
    environmentProviders: RegisteredRunnerContribution<RunnerEnvironmentProviderContribution>[]
    commandResolvers: RegisteredRunnerContribution<RunnerCommandResolverContribution>[]
    spawnHooks: RegisteredRunnerContribution<RunnerSpawnHookContribution>[]
    timeoutMs?: number
    pathDelimiter?: string
    sanitizeDiagnostic?: RunnerPluginDiagnosticSanitizer
    platform?: NodeJS.Platform
}

export type ResolveRunnerSpawnOptionsInput = {
    machineId: string
    options: SpawnSessionOptions
    agent: string
    cwd: string
    spawnOptionsProviders: RegisteredRunnerContribution<RunnerSpawnOptionsProviderContribution>[]
    timeoutMs?: number
    sanitizeDiagnostic?: RunnerPluginDiagnosticSanitizer
}

function contributionSort<T>(left: RegisteredRunnerContribution<T>, right: RegisteredRunnerContribution<T>): number {
    return left.priority - right.priority
        || left.pluginId.localeCompare(right.pluginId)
        || left.id.localeCompare(right.id)
        || left.order - right.order
}

function contributionDiagnostic(
    entry: { pluginId: string; id: string },
    severity: PluginDiagnostic['severity'],
    code: string,
    message: string
): PluginDiagnostic & { pluginId: string } {
    return { pluginId: entry.pluginId, severity, code, message }
}

function contributionLabel(entry: { pluginId: string; id: string }): string {
    return `${entry.pluginId}:${entry.id}`
}

function sanitizeForPlugin(input: { sanitizeDiagnostic?: RunnerPluginDiagnosticSanitizer }, pluginId: string, value: unknown): string {
    if (input.sanitizeDiagnostic) {
        return input.sanitizeDiagnostic(pluginId, value)
    }
    return value instanceof Error ? value.message : String(value)
}

function withTimeout<T>(work: MaybePromise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null
    return Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
    ]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

function isCrossPlatformAbsolutePath(value: string): boolean {
    return isAbsolute(value) || win32.isAbsolute(value)
}

function pathIsInsideWithPlatform(parentPath: string, childPath: string, platform: NodeJS.Platform): boolean {
    const pathImpl = platform === 'win32' ? win32 : { relative, isAbsolute }
    const rel = pathImpl.relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !pathImpl.isAbsolute(rel))
}

function appendMissingRunnerControlArgs(args: {
    entry: { pluginId: string; id: string }
    proposedArgs: string[]
    baseDisplayArgs: string[]
    diagnostics: PluginDiagnostic[]
}): string[] {
    const cleaned: string[] = []
    const requiredPairs: string[] = []
    for (let index = 0; index < args.baseDisplayArgs.length; index += 1) {
        const flag = args.baseDisplayArgs[index]
        if (!REQUIRED_RUNNER_CONTROL_FLAGS.has(flag)) continue
        const value = args.baseDisplayArgs[index + 1]
        if (value === undefined) continue
        requiredPairs.push(flag, value)
    }
    if (requiredPairs.length === 0) {
        return args.proposedArgs
    }

    let changed = false
    for (let index = 0; index < args.proposedArgs.length; index += 1) {
        const flag = args.proposedArgs[index]
        if (!REQUIRED_RUNNER_CONTROL_FLAGS.has(flag)) {
            cleaned.push(flag)
            continue
        }
        const proposedValue = args.proposedArgs[index + 1]
        const baseIndex = requiredPairs.indexOf(flag)
        const requiredValue = baseIndex === -1 ? undefined : requiredPairs[baseIndex + 1]
        if (proposedValue !== requiredValue) {
            changed = true
        }
        index += proposedValue === undefined ? 0 : 1
    }

    for (let index = 0; index < requiredPairs.length; index += 2) {
        cleaned.push(requiredPairs[index]!, requiredPairs[index + 1]!)
    }

    if (changed || cleaned.length !== args.proposedArgs.length) {
        args.diagnostics.push(contributionDiagnostic(
            args.entry,
            'warning',
            'runner-extension-command-control-preserved',
            `${contributionLabel(args.entry)} attempted to modify Runner control flags; required remote Runner flags were restored.`
        ))
    }
    return cleaned
}

function normalizeBaseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function envKeyIsProtected(key: string, platform: NodeJS.Platform): boolean {
    if (platform === 'win32') {
        const normalized = key.toUpperCase()
        return normalized.startsWith('HAPI_') || PROTECTED_ENV_KEYS.has(normalized)
    }
    return key.startsWith('HAPI_') || PROTECTED_ENV_KEYS.has(key)
}

function findEnvKeyCaseInsensitive(env: Record<string, string>, key: string): string | undefined {
    const normalized = key.toUpperCase()
    return Object.keys(env).find((candidate) => candidate.toUpperCase() === normalized)
}

function isPathEnvKey(key: string, platform: NodeJS.Platform): boolean {
    return platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH'
}

export function mergePathValue(args: {
    base?: string
    prepend?: string[]
    append?: string[]
    delimiter?: string
}): string {
    const separator = args.delimiter ?? delimiter
    const current = args.base ? args.base.split(separator).filter(Boolean) : []
    const next = [...(args.prepend ?? []), ...current, ...(args.append ?? [])]
    const seen = new Set<string>()
    return next.filter((entry) => {
        if (seen.has(entry)) return false
        seen.add(entry)
        return true
    }).join(separator)
}

function buildContext(input: ResolveRunnerSpawnPlanInput, plan: RunnerSpawnBasePlan): RunnerSpawnContext {
    return RunnerSpawnContextSchema.parse({
        machineId: input.machineId,
        agent: input.agent,
        directory: input.options.directory,
        cwd: plan.cwd,
        args: plan.displayArgs,
        envKeys: Object.keys(plan.env).filter((key) => typeof plan.env[key] === 'string').sort(),
        ...(input.options.sessionType ? { sessionType: input.options.sessionType } : {}),
        ...(input.options.worktreeName ? { worktreeName: input.options.worktreeName } : {}),
        ...(input.options.resumeSessionId ? { resumeSessionId: input.options.resumeSessionId } : {}),
        ...(input.options.model ? { model: input.options.model } : {}),
        ...(input.options.effort ? { effort: input.options.effort } : {}),
        ...(input.options.modelReasoningEffort ? { modelReasoningEffort: input.options.modelReasoningEffort } : {}),
        ...(input.options.permissionMode ? { permissionMode: input.options.permissionMode } : {}),
        ...(input.options.yolo !== undefined ? { yolo: input.options.yolo } : {}),
        ...(input.options.manualFields?.length ? { manualFields: input.options.manualFields } : {}),
        ...(input.options.pluginFields ? { pluginFields: input.options.pluginFields } : {})
    })
}

function buildOptionsContext(input: ResolveRunnerSpawnOptionsInput, options: SpawnSessionOptions): RunnerSpawnOptionsContext {
    return RunnerSpawnOptionsContextSchema.parse({
        machineId: input.machineId,
        agent: input.agent,
        directory: options.directory,
        cwd: input.cwd,
        ...(options.sessionType ? { sessionType: options.sessionType } : {}),
        ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
        ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.modelReasoningEffort ? { modelReasoningEffort: options.modelReasoningEffort } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.yolo !== undefined ? { yolo: options.yolo } : {}),
        ...(options.manualFields?.length ? { manualFields: options.manualFields } : {}),
        ...(options.pluginFields ? { pluginFields: options.pluginFields } : {})
    })
}

function proposalFields(proposal: RunnerSpawnOptionDefaults): string[] {
    return (Object.entries(proposal) as Array<[keyof RunnerSpawnOptionDefaults, unknown]>)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
}

function applySpawnOptionsProposal(args: {
    entry: { pluginId: string; id: string }
    options: SpawnSessionOptions
    proposal: RunnerSpawnOptionDefaults
    audit: RunnerExtensionAuditEvent[]
    diagnostics: PluginDiagnostic[]
}): string[] {
    const source = contributionLabel(args.entry)
    const fields: string[] = []
    const manualFields = new Set(args.options.manualFields ?? [])
    for (const [key, value] of Object.entries(args.proposal) as Array<[keyof RunnerSpawnOptionDefaults, unknown]>) {
        if (value === undefined) continue
        if (isManualSpawnOption(manualFields, key)) {
            args.diagnostics.push(contributionDiagnostic(
                args.entry,
                'info',
                'runner-extension-manual-field-skipped',
                `${source} proposed launch option ${key}, but the user set it manually; proposal ignored.`
            ))
            args.audit.push({
                phase: 'spawnOptions',
                pluginId: args.entry.pluginId,
                contributionId: args.entry.id,
                field: `options.${key}`,
                message: `${source} skipped manual launch option ${key}`
            })
            continue
        }
        ;(args.options as unknown as Record<string, unknown>)[key] = value
        fields.push(key)
        args.audit.push({
            phase: 'spawnOptions',
            pluginId: args.entry.pluginId,
            contributionId: args.entry.id,
            field: `options.${key}`,
            message: `${source} set launch option ${key}`
        })
    }
    return fields
}

function isManualSpawnOption(manualFields: Set<string>, key: keyof RunnerSpawnOptionDefaults): boolean {
    if (key === 'permissionMode' || key === 'yolo') {
        return manualFields.has('permissionMode') || manualFields.has('yolo')
    }
    return manualFields.has(key)
}

function stripControlOnlySpawnOptions(options: SpawnSessionOptions): SpawnSessionOptions {
    const clean = { ...options } as SpawnSessionOptions & { machineId?: unknown }
    delete clean.machineId
    return clean
}

function applyEnvPatch(args: {
    phase: RunnerExtensionAuditEvent['phase']
    entry: { pluginId: string; id: string }
    env: Record<string, string>
    proposal: { env?: Record<string, string>; pathPrepend?: string[]; pathAppend?: string[]; cwd?: string; toolPaths?: Record<string, string>; diagnostics?: PluginDiagnostic[] }
    audit: RunnerExtensionAuditEvent[]
    diagnostics: PluginDiagnostic[]
    pathDelimiter: string
    sanitizeDiagnostic?: RunnerPluginDiagnosticSanitizer
    platform: NodeJS.Platform
    allowedCwdRoots?: string[]
}): { cwd?: string } {
    const source = contributionLabel(args.entry)
    for (const [key, value] of Object.entries(args.proposal.env ?? {})) {
        if (envKeyIsProtected(key, args.platform) || isPathEnvKey(key, args.platform)) {
            args.diagnostics.push(contributionDiagnostic(args.entry, 'warning', 'runner-extension-env-protected', `${source} attempted to modify protected env ${key}; proposal ignored.`))
            continue
        }
        args.env[key] = value
        args.audit.push({ phase: args.phase, pluginId: args.entry.pluginId, contributionId: args.entry.id, field: `env.${key}`, message: `${source} set env ${key}` })
    }

    if (args.proposal.pathPrepend?.length || args.proposal.pathAppend?.length) {
        const pathKey = args.platform === 'win32'
            ? findEnvKeyCaseInsensitive(args.env, 'PATH') ?? 'PATH'
            : 'PATH'
        args.env[pathKey] = mergePathValue({
            base: args.env[pathKey],
            prepend: args.proposal.pathPrepend,
            append: args.proposal.pathAppend,
            delimiter: args.pathDelimiter
        })
        args.audit.push({ phase: args.phase, pluginId: args.entry.pluginId, contributionId: args.entry.id, field: `env.${pathKey}`, message: `${source} updated PATH segments` })
    }

    if (args.proposal.toolPaths && Object.keys(args.proposal.toolPaths).length > 0) {
        args.diagnostics.push(contributionDiagnostic(args.entry, 'warning', 'runner-extension-tool-paths-reserved', `${source} proposed toolPaths, but toolPaths is reserved and is not applied by this Runner.`))
    }

    for (const pluginDiagnostic of args.proposal.diagnostics ?? []) {
        args.diagnostics.push({
            ...pluginDiagnostic,
            message: sanitizeForPlugin(args, args.entry.pluginId, pluginDiagnostic.message),
            pluginId: args.entry.pluginId
        } as PluginDiagnostic & { pluginId: string })
    }

    if (args.proposal.cwd !== undefined) {
        if (!isCrossPlatformAbsolutePath(args.proposal.cwd)) {
            args.diagnostics.push(contributionDiagnostic(args.entry, 'warning', 'runner-extension-cwd-invalid', `${source} proposed a non-absolute cwd; proposal ignored.`))
            return {}
        }
        if (args.allowedCwdRoots?.length && !args.allowedCwdRoots.some((root) => pathIsInsideWithPlatform(root, args.proposal.cwd!, args.platform))) {
            args.diagnostics.push(contributionDiagnostic(args.entry, 'warning', 'runner-extension-cwd-outside-workspace', `${source} proposed a cwd outside the Runner spawn workspace; proposal ignored.`))
            return {}
        }
        const cwd = sanitizeForPlugin(args, args.entry.pluginId, args.proposal.cwd)
        args.audit.push({ phase: args.phase, pluginId: args.entry.pluginId, contributionId: args.entry.id, field: 'cwd', message: `${source} proposed cwd ${cwd}` })
        return { cwd: args.proposal.cwd }
    }

    return {}
}

function validateContributionCommandProposal(
    entry: { pluginId: string; id: string },
    args: string[],
    diagnostics: PluginDiagnostic[]
): boolean {
    const source = contributionLabel(entry)
    if (args.length === 0) {
        diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-empty', `${source} proposed empty args; proposal ignored.`))
        return false
    }
    if (!ALLOWED_HAPI_SUBCOMMANDS.has(args[0])) {
        diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-disallowed', `${source} proposed disallowed HAPI subcommand ${args[0]}; proposal ignored.`))
        return false
    }
    if (args.some((arg) => arg.includes('\0'))) {
        diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-invalid', `${source} proposed args containing NUL; proposal ignored.`))
        return false
    }
    return true
}

async function runEnvironmentProviders(input: ResolveRunnerSpawnPlanInput, state: {
    command: string
    args: string[]
    displayArgs: string[]
    cwd: string
    env: Record<string, string>
    diagnostics: PluginDiagnostic[]
    audit: RunnerExtensionAuditEvent[]
}): Promise<void> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...input.environmentProviders].sort(contributionSort)) {
        if (!entry.contribution.provide) continue
        try {
            const context = buildContext(input, { ...input.basePlan, cwd: state.cwd, env: state.env, args: state.args, displayArgs: state.displayArgs, command: state.command })
            const parsed = RunnerEnvironmentProposalSchema.parse(await withTimeout(entry.contribution.provide(context), timeoutMs, contributionLabel(entry)))
            const cwdPatch = applyEnvPatch({
                phase: 'environment',
                entry,
                env: state.env,
                proposal: parsed,
                audit: state.audit,
                diagnostics: state.diagnostics,
                pathDelimiter: input.pathDelimiter ?? delimiter,
                sanitizeDiagnostic: input.sanitizeDiagnostic,
                platform: input.platform ?? process.platform,
                allowedCwdRoots: [input.basePlan.cwd]
            })
            if (cwdPatch.cwd) state.cwd = cwdPatch.cwd
        } catch (error) {
            state.diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-environment-failed', `${contributionLabel(entry)} environment provider failed: ${sanitizeForPlugin(input, entry.pluginId, error)}`))
        }
    }
}

async function runCommandResolvers(input: ResolveRunnerSpawnPlanInput, state: {
    command: string
    args: string[]
    displayArgs: string[]
    cwd: string
    env: Record<string, string>
    diagnostics: PluginDiagnostic[]
    audit: RunnerExtensionAuditEvent[]
}): Promise<void> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...input.commandResolvers].sort(contributionSort)) {
        if (!entry.contribution.resolve) continue
        const source = contributionLabel(entry)
        try {
            const context = buildContext(input, { ...input.basePlan, cwd: state.cwd, env: state.env, args: state.args, displayArgs: state.displayArgs, command: state.command })
            const parsed: RunnerCommandResolverProposal = RunnerCommandResolverProposalSchema.parse(await withTimeout(entry.contribution.resolve(context), timeoutMs, source))
            if (parsed.args && validateContributionCommandProposal(entry, parsed.args, state.diagnostics)) {
                const nextDisplayArgs = appendMissingRunnerControlArgs({
                    entry,
                    proposedArgs: parsed.args,
                    baseDisplayArgs: input.basePlan.displayArgs,
                    diagnostics: state.diagnostics
                })
                const currentDisplayArgCount = state.displayArgs.length
                state.displayArgs = nextDisplayArgs
                state.args = input.basePlan.mode === 'development'
                    ? [...state.args.slice(0, state.args.length - currentDisplayArgCount), ...nextDisplayArgs]
                    : nextDisplayArgs
                state.audit.push({ phase: 'command', pluginId: entry.pluginId, contributionId: entry.id, field: 'args', message: `${source} proposed HAPI args` })
            }
            const cwdPatch = applyEnvPatch({
                phase: 'command',
                entry,
                env: state.env,
                proposal: parsed,
                audit: state.audit,
                diagnostics: state.diagnostics,
                pathDelimiter: input.pathDelimiter ?? delimiter,
                sanitizeDiagnostic: input.sanitizeDiagnostic,
                platform: input.platform ?? process.platform,
                allowedCwdRoots: [input.basePlan.cwd]
            })
            if (cwdPatch.cwd) state.cwd = cwdPatch.cwd
        } catch (error) {
            state.diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-failed', `${source} command resolver failed: ${sanitizeForPlugin(input, entry.pluginId, error)}`))
        }
    }
}

async function runBeforeSpawnHooks(input: ResolveRunnerSpawnPlanInput, state: {
    command: string
    args: string[]
    displayArgs: string[]
    cwd: string
    env: Record<string, string>
    diagnostics: PluginDiagnostic[]
    audit: RunnerExtensionAuditEvent[]
}): Promise<{ blocked?: { reason: string } }> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...input.spawnHooks].sort(contributionSort)) {
        if (!entry.contribution.beforeSpawn) continue
        const source = contributionLabel(entry)
        try {
            const context = buildContext(input, { ...input.basePlan, cwd: state.cwd, env: state.env, args: state.args, displayArgs: state.displayArgs, command: state.command })
            const parsed: RunnerSpawnHookProposal = RunnerSpawnHookProposalSchema.parse(await withTimeout(entry.contribution.beforeSpawn(context), timeoutMs, source))
            const cwdPatch = applyEnvPatch({
                phase: 'beforeSpawn',
                entry,
                env: state.env,
                proposal: parsed,
                audit: state.audit,
                diagnostics: state.diagnostics,
                pathDelimiter: input.pathDelimiter ?? delimiter,
                sanitizeDiagnostic: input.sanitizeDiagnostic,
                platform: input.platform ?? process.platform,
                allowedCwdRoots: [input.basePlan.cwd]
            })
            if (cwdPatch.cwd) state.cwd = cwdPatch.cwd
            if (parsed.block) {
                state.audit.push({ phase: 'beforeSpawn', pluginId: entry.pluginId, contributionId: entry.id, message: `${source} blocked spawn: ${sanitizeForPlugin(input, entry.pluginId, parsed.block.reason)}` })
                return { blocked: { reason: sanitizeForPlugin(input, entry.pluginId, parsed.block.reason) } }
            }
        } catch (error) {
            state.diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-before-spawn-failed', `${source} beforeSpawn hook failed: ${sanitizeForPlugin(input, entry.pluginId, error)}`))
        }
    }
    return {}
}

export async function resolveRunnerPluginSpawnOptions(input: ResolveRunnerSpawnOptionsInput): Promise<RunnerResolvedSpawnOptions> {
    const options: SpawnSessionOptions = { ...stripControlOnlySpawnOptions(input.options), agent: input.agent }
    const diagnostics: PluginDiagnostic[] = []
    const audit: RunnerExtensionAuditEvent[] = []
    const applied: RunnerSpawnOptionsAppliedEntry[] = []
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS

    for (const entry of [...input.spawnOptionsProviders].sort(contributionSort)) {
        if (!entry.contribution.provide) continue
        const source = contributionLabel(entry)
        try {
            const context = buildOptionsContext(input, options)
            const parsed = RunnerSpawnOptionsProviderProposalSchema.parse(await withTimeout(entry.contribution.provide(context), timeoutMs, source))
            let appliedOptionFields: string[] = []
            for (const pluginDiagnostic of parsed.diagnostics ?? []) {
                diagnostics.push({
                    ...pluginDiagnostic,
                    message: sanitizeForPlugin(input, entry.pluginId, pluginDiagnostic.message),
                    pluginId: entry.pluginId
                } as PluginDiagnostic & { pluginId: string })
            }
            if (parsed.options) {
                appliedOptionFields = applySpawnOptionsProposal({
                    entry,
                    options,
                    proposal: parsed.options,
                    audit,
                    diagnostics
                })
                if (!parsed.applied?.length && appliedOptionFields.length > 0) {
                    applied.push({
                        pluginId: entry.pluginId,
                        contributionId: entry.id,
                        label: entry.id,
                        fields: appliedOptionFields
                    })
                }
            }
            const appliedFieldSet = new Set(appliedOptionFields)
            for (const item of parsed.applied ?? []) {
                const fields = item.fields ?? (parsed.options ? proposalFields(parsed.options) : undefined)
                const appliedFields = parsed.options && fields
                    ? fields.filter((field) => appliedFieldSet.has(field))
                    : fields
                applied.push({
                    pluginId: entry.pluginId,
                    contributionId: entry.id,
                    label: item.label ?? entry.id,
                    ...(item.description ? { description: item.description } : {}),
                    ...(appliedFields && appliedFields.length > 0 ? { fields: appliedFields } : {})
                })
            }
        } catch (error) {
            diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-spawn-options-failed', `${source} spawn options provider failed: ${sanitizeForPlugin(input, entry.pluginId, error)}`))
        }
    }

    return RunnerResolvedSpawnOptionsSchema.parse({ options, diagnostics, audit, applied })
}

export async function resolveRunnerPluginSpawnPlan(input: ResolveRunnerSpawnPlanInput): Promise<RunnerResolvedSpawnPlan> {
    const state = {
        command: input.basePlan.command,
        args: [...input.basePlan.args],
        displayArgs: [...input.basePlan.displayArgs],
        cwd: input.basePlan.cwd,
        env: normalizeBaseEnv(input.basePlan.env),
        diagnostics: [] as PluginDiagnostic[],
        audit: [] as RunnerExtensionAuditEvent[]
    }

    await runEnvironmentProviders(input, state)
    await runCommandResolvers(input, state)
    const beforeSpawn = await runBeforeSpawnHooks(input, state)

    return {
        command: state.command,
        args: state.args,
        displayArgs: state.displayArgs,
        cwd: state.cwd,
        env: state.env,
        diagnostics: state.diagnostics,
        audit: state.audit,
        ...(beforeSpawn.blocked ? { blocked: beforeSpawn.blocked } : {})
    }
}

export async function runRunnerPluginAfterSpawnHooks(args: {
    baseContext: RunnerSpawnContext
    pid: number
    hooks: RegisteredRunnerContribution<RunnerSpawnHookContribution>[]
    timeoutMs?: number
    onDiagnostic?: (diagnostic: PluginDiagnostic) => void
    sanitizeDiagnostic?: RunnerPluginDiagnosticSanitizer
}): Promise<void> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...args.hooks].sort(contributionSort)) {
        if (!entry.contribution.afterSpawn) continue
        const source = contributionLabel(entry)
        try {
            await withTimeout(entry.contribution.afterSpawn({ ...args.baseContext, pid: args.pid }), timeoutMs, source)
        } catch (error) {
            args.onDiagnostic?.(contributionDiagnostic(entry, 'warning', 'runner-extension-after-spawn-failed', `${source} afterSpawn hook failed: ${sanitizeForPlugin(args, entry.pluginId, error)}`))
        }
    }
}

export async function runRunnerPluginExitHooks(args: {
    baseContext: RunnerSpawnContext
    pid: number
    exitCode: number | null
    signal: NodeJS.Signals | null
    hooks: RegisteredRunnerContribution<RunnerSpawnHookContribution>[]
    timeoutMs?: number
    onDiagnostic?: (diagnostic: PluginDiagnostic) => void
    sanitizeDiagnostic?: RunnerPluginDiagnosticSanitizer
}): Promise<void> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...args.hooks].sort(contributionSort)) {
        if (!entry.contribution.onExit) continue
        const source = contributionLabel(entry)
        try {
            await withTimeout(entry.contribution.onExit({ ...args.baseContext, pid: args.pid, exitCode: args.exitCode, signal: args.signal }), timeoutMs, source)
        } catch (error) {
            args.onDiagnostic?.(contributionDiagnostic(entry, 'warning', 'runner-extension-on-exit-failed', `${source} onExit hook failed: ${sanitizeForPlugin(args, entry.pluginId, error)}`))
        }
    }
}
