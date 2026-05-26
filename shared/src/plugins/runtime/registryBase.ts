import type { Disposable, PluginConfigReader, PluginLogger, PluginNetwork, PluginSecretReader } from '../sdk'
import type { PluginDiagnostic } from '../types'
import { createPluginNetwork } from './networkPolicy'

export type PluginLogLevel = keyof PluginLogger

export type RuntimeRegistryContribution<TType extends string = string, TContribution = unknown> = {
    type: TType
    pluginId: string
    id: string
    priority: number
    order: number
    contribution: TContribution
    disposed: boolean
}

export type RuntimeRegistryBaseOptions = {
    registrationClosedMessage: string
    diagnosticPrefix(pluginId: string): string
    writeLog(level: PluginLogLevel, pluginId: string, message: string, args: unknown[]): void
    onDisposeError(error: unknown): void
}

export type RuntimeContextParts = {
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    network: PluginNetwork
    declaredSecrets: string[]
    env: NodeJS.ProcessEnv
    assertAccepting(message?: string): void
    close(): void
}

export abstract class PluginRuntimeRegistryBase<TType extends string> {
    protected readonly contributions: Array<RuntimeRegistryContribution<TType> & Record<string, unknown>> = []
    protected readonly disposables: Disposable[] = []
    protected nextContributionOrder = 0
    readonly diagnostics: PluginDiagnostic[] = []

    protected constructor(private readonly options: RuntimeRegistryBaseOptions) {}

    addDiagnostic(severity: PluginDiagnostic['severity'], code: string, message: string, pluginId: string, path?: string): void {
        this.diagnostics.push({
            severity,
            code,
            message: `${this.options.diagnosticPrefix(pluginId)} ${message}`,
            ...(path ? { path } : {})
        })
    }

    async dispose(): Promise<void> {
        for (const disposable of [...this.disposables].reverse()) {
            try {
                await disposable.dispose()
            } catch (error) {
                this.options.onDisposeError(error)
            }
        }
        this.disposables.length = 0
        this.contributions.length = 0
    }

    getDisposableCount(): number {
        return this.disposables.length
    }

    async disposeFrom(startIndex: number): Promise<void> {
        const extras = this.disposables.splice(startIndex)
        for (const disposable of extras.reverse()) {
            try {
                await disposable.dispose()
            } catch (error) {
                this.options.onDisposeError(error)
            }
        }
    }

    protected createCommonContextParts(args: {
        pluginId: string
        config?: Record<string, unknown>
        declaredSecrets?: string[]
        declaredNetwork?: string[]
        env?: NodeJS.ProcessEnv
    }): RuntimeContextParts {
        let acceptingRegistrations = true
        const declaredSecrets = args.declaredSecrets ?? []
        const declaredSecretSet = new Set(declaredSecrets)
        const env = args.env ?? process.env
        for (const secretName of declaredSecrets) {
            if (!env[secretName]) {
                this.addDiagnostic('warning', 'missing-secret', `Declared secret ${secretName} is not set.`, args.pluginId)
            }
        }

        return {
            logger: this.createLogger(args.pluginId, declaredSecrets, env),
            config: {
                get: <T = unknown>(key: string): T | undefined => args.config?.[key] as T | undefined,
                all: (): Record<string, unknown> => ({ ...(args.config ?? {}) })
            },
            secrets: {
                get: (name: string): string | undefined => {
                    if (!declaredSecretSet.has(name)) {
                        this.addDiagnostic('warning', 'undeclared-secret', `Plugin attempted to read undeclared secret ${name}.`, args.pluginId)
                        return undefined
                    }
                    return env[name]
                }
            },
            network: createPluginNetwork({
                pluginId: args.pluginId,
                declaredNetwork: args.declaredNetwork ?? [],
                onDiagnostic: (severity, code, message) => this.addDiagnostic(severity, code, message, args.pluginId)
            }),
            declaredSecrets,
            env,
            assertAccepting: (message?: string) => {
                if (!acceptingRegistrations) {
                    throw new Error(message ?? this.options.registrationClosedMessage)
                }
            },
            close: () => {
                acceptingRegistrations = false
            }
        }
    }

    protected registerContribution<TContribution extends { id: string; priority?: number }, TExtra extends Record<string, unknown> = Record<string, never>>(
        type: TType,
        pluginId: string,
        contribution: TContribution,
        extra?: TExtra
    ): Disposable {
        const entry = {
            type,
            pluginId,
            id: contribution.id,
            priority: contribution.priority ?? 0,
            order: this.nextContributionOrder++,
            contribution,
            disposed: false,
            ...(extra ?? {})
        } as RuntimeRegistryContribution<TType, TContribution> & TExtra
        this.contributions.push(entry as RuntimeRegistryContribution<TType> & Record<string, unknown>)

        const disposable: Disposable = {
            dispose: async () => {
                if (entry.disposed) {
                    return
                }
                entry.disposed = true
                const index = this.contributions.indexOf(entry as RuntimeRegistryContribution<TType> & Record<string, unknown>)
                if (index >= 0) {
                    this.contributions.splice(index, 1)
                }
                if ('dispose' in contribution && typeof contribution.dispose === 'function') {
                    await contribution.dispose()
                }
            }
        }
        this.disposables.push(disposable)
        return disposable
    }

    protected getContributionsByType<TContribution, TExtra extends Record<string, unknown> = Record<string, never>>(
        type: TType
    ): Array<RuntimeRegistryContribution<TType, TContribution> & TExtra> {
        return this.contributions
            .filter((entry): entry is RuntimeRegistryContribution<TType, TContribution> & TExtra => entry.type === type && !entry.disposed)
            .map((entry) => ({ ...entry }))
    }

    private createLogger(pluginId: string, declaredSecrets: string[], env: NodeJS.ProcessEnv): PluginLogger {
        const redactArgs = (args: unknown[]) => args.map((arg) => redactUnknown(arg, declaredSecrets, env))
        const write = (level: PluginLogLevel, message: string, args: unknown[]) => {
            this.options.writeLog(level, pluginId, redactText(message, declaredSecrets, env), redactArgs(args))
        }
        return {
            debug: (message, ...args) => write('debug', message, args),
            info: (message, ...args) => write('info', message, args),
            warn: (message, ...args) => write('warn', message, args),
            error: (message, ...args) => write('error', message, args)
        }
    }
}

export function sanitizeError(error: unknown, declaredSecrets: string[], env: NodeJS.ProcessEnv = process.env): Error {
    if (error instanceof Error) {
        return new Error(redactText(error.message, declaredSecrets, env))
    }
    return new Error(redactText(String(error), declaredSecrets, env))
}

export function redactText(value: string, declaredSecrets: string[], env: NodeJS.ProcessEnv = process.env): string {
    let redacted = value
    for (const secretName of declaredSecrets) {
        const secretValue = env[secretName]
        if (secretValue) {
            redacted = redacted.split(secretValue).join('[REDACTED]')
        }
    }
    return redacted
}

export function redactUnknown(
    value: unknown,
    declaredSecrets: string[],
    env: NodeJS.ProcessEnv,
    seen: WeakSet<object> = new WeakSet()
): unknown {
    if (typeof value === 'string') {
        return redactText(value, declaredSecrets, env)
    }
    if (value instanceof Error) {
        return new Error(redactText(value.message, declaredSecrets, env))
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactUnknown(entry, declaredSecrets, env, seen))
    }
    if (value && typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]'
        }
        seen.add(value)
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry, declaredSecrets, env, seen)])
        )
    }
    return value
}
