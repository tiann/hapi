import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
    AgentProviderSchema,
    CodexWireApiSchema,
    ProviderHealthSummarySchema,
    ProviderProfileInputSchema,
    ProviderCredentialTypeSchema,
    ProviderModelSchema,
    ProviderProfileUpdateSchema,
    ProviderProtocolSchema,
    formatProviderModelReference,
    parseProviderModelReference,
    type AgentProvider,
    type ProviderHealthCheckResponse,
    type ProviderListResponse,
    type ProviderModel,
    type ProviderProfileInput,
    type ProviderProfileUpdate,
    type ProviderProfileView
} from '@hapi/protocol'
import { configuration } from '@/configuration'

const StoredProfileSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    agent: AgentProviderSchema,
    protocol: ProviderProtocolSchema,
    baseUrl: z.string().optional(),
    credentialType: ProviderCredentialTypeSchema,
    apiKey: z.string(),
    defaultModel: z.string().optional(),
    models: z.array(ProviderModelSchema).default([]),
    health: ProviderHealthSummarySchema.default({ status: 'unverified' }),
    codexWireApi: CodexWireApiSchema.optional(),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    createdAt: z.number().int(),
    updatedAt: z.number().int()
})

type StoredProfile = z.infer<typeof StoredProfileSchema>
type NamespaceStore = {
    profiles: StoredProfile[]
    defaults: Record<AgentProvider, string | null>
}
type ProviderDocument = {
    version: 1
    namespaces: Record<string, NamespaceStore>
}

const EmptyDefaults: Record<AgentProvider, null> = {
    claude: null,
    codex: null,
    cursor: null,
    grok: null,
    kimi: null,
    opencode: null,
    pi: null
}

function namespaceFromToken(token: string): string {
    const trimmed = token.trim()
    const separator = trimmed.lastIndexOf(':')
    if (separator <= 0 || separator === trimmed.length - 1) return 'default'
    return trimmed.slice(separator + 1)
}

function emptyDocument(): ProviderDocument {
    return { version: 1, namespaces: {} }
}

function mergeModels(discovered: ProviderModel[], custom: ProviderModel[]): ProviderModel[] {
    const byId = new Map<string, ProviderModel>()
    for (const model of discovered) byId.set(model.id, model)
    for (const model of custom) byId.set(model.id, model)
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function publicView(profile: StoredProfile): ProviderProfileView {
    const secret = profile.apiKey.trim()
    return {
        id: profile.id,
        name: profile.name,
        agent: profile.agent,
        protocol: profile.protocol,
        ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
        credentialType: profile.credentialType,
        ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
        models: profile.models,
        health: profile.health,
        ...(profile.codexWireApi ? { codexWireApi: profile.codexWireApi } : {}),
        enabled: profile.enabled,
        revision: profile.revision,
        hasSecret: secret.length > 0,
        ...(secret.length >= 4 ? { secretHint: `••••${secret.slice(-4)}` } : {}),
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt
    }
}

export type ResolvedProviderProfile = StoredProfile

export class ProviderRegistry {
    private readonly filePath: string
    private readonly namespace: string

    constructor(options?: { filePath?: string; namespace?: string }) {
        this.filePath = options?.filePath ?? join(configuration.happyHomeDir, 'providers.json')
        this.namespace = options?.namespace ?? namespaceFromToken(configuration.cliApiToken)
    }

    async list(agent?: AgentProvider): Promise<ProviderListResponse> {
        const store = this.getNamespace(await this.readDocument())
        return {
            success: true,
            profiles: store.profiles.filter((profile) => !agent || profile.agent === agent).map(publicView),
            defaults: { ...store.defaults }
        }
    }

    async create(input: ProviderProfileInput): Promise<ProviderProfileView> {
        const parsedInput = ProviderProfileInputSchema.parse(input)
        let created: StoredProfile | null = null
        await this.updateDocument((document) => {
            const store = this.getNamespace(document)
            const now = Date.now()
            created = {
                id: randomUUID(),
                name: parsedInput.name,
                agent: parsedInput.agent,
                protocol: parsedInput.protocol,
                ...(parsedInput.baseUrl ? { baseUrl: parsedInput.baseUrl } : {}),
                credentialType: parsedInput.credentialType,
                apiKey: parsedInput.apiKey,
                ...(parsedInput.defaultModel ? { defaultModel: formatProviderModelReference(parseProviderModelReference(parsedInput.defaultModel)) } : {}),
                models: parsedInput.models.map((value) => ({
                    ...parseProviderModelReference(value),
                    source: 'custom' as const
                })),
                health: { status: 'unverified' as const },
                ...(parsedInput.codexWireApi ? { codexWireApi: parsedInput.codexWireApi } : {}),
                enabled: parsedInput.enabled,
                revision: 1,
                createdAt: now,
                updatedAt: now
            }
            store.profiles.push(created)
            if (parsedInput.enabled && !store.defaults[parsedInput.agent]) store.defaults[parsedInput.agent] = created.id
        })
        if (!created) throw new Error('Failed to create provider profile')
        return publicView(created)
    }

    async update(id: string, patch: ProviderProfileUpdate): Promise<ProviderProfileView> {
        const parsedPatch = ProviderProfileUpdateSchema.parse(patch)
        let updated: StoredProfile | null = null
        await this.updateDocument((document) => {
            const store = this.getNamespace(document)
            const index = store.profiles.findIndex((profile) => profile.id === id)
            if (index === -1) throw new Error('Provider profile not found')
            const current = store.profiles[index]
            const nextAgent = parsedPatch.agent ?? current.agent
            const nextProtocol = parsedPatch.protocol ?? current.protocol
            const nextCredentialType = parsedPatch.credentialType ?? current.credentialType
            const nextCustomModels = parsedPatch.models === undefined
                ? current.models.filter((model) => model.source === 'custom')
                : (parsedPatch.models ?? []).map((value) => ({
                    ...parseProviderModelReference(value),
                    source: 'custom' as const
                }))
            ProviderProfileInputSchema.parse({
                name: parsedPatch.name ?? current.name,
                agent: nextAgent,
                protocol: nextProtocol,
                baseUrl: parsedPatch.baseUrl === null ? undefined : parsedPatch.baseUrl ?? current.baseUrl,
                credentialType: nextCredentialType,
                apiKey: parsedPatch.apiKey ?? current.apiKey,
                defaultModel: parsedPatch.defaultModel === null ? undefined : parsedPatch.defaultModel ?? current.defaultModel,
                models: nextCustomModels.map(formatProviderModelReference),
                codexWireApi: parsedPatch.codexWireApi === null ? undefined : parsedPatch.codexWireApi ?? current.codexWireApi,
                enabled: parsedPatch.enabled ?? current.enabled
            })
            const {
                baseUrl,
                defaultModel,
                codexWireApi,
                models,
                apiKey,
                ...simplePatch
            } = parsedPatch
            const next: StoredProfile = {
                ...current,
                ...simplePatch,
                agent: nextAgent,
                protocol: nextProtocol,
                apiKey: apiKey ?? current.apiKey,
                revision: current.revision + 1,
                updatedAt: Date.now()
            }
            if (baseUrl === null) delete next.baseUrl
            else if (baseUrl !== undefined) next.baseUrl = baseUrl
            if (defaultModel === null) delete next.defaultModel
            else if (defaultModel !== undefined) next.defaultModel = formatProviderModelReference(parseProviderModelReference(defaultModel))
            if (models !== undefined) {
                const discovered = current.models.filter((model) => model.source === 'provider')
                next.models = mergeModels(discovered, nextCustomModels)
            }
            if (codexWireApi === null) delete next.codexWireApi
            else if (codexWireApi !== undefined) next.codexWireApi = codexWireApi
            if (nextAgent !== 'codex') delete next.codexWireApi
            store.profiles[index] = next
            updated = next
            if (current.agent !== nextAgent && store.defaults[current.agent] === id) {
                store.defaults[current.agent] = null
            }
            if (!next.enabled && store.defaults[nextAgent] === id) {
                store.defaults[nextAgent] = null
            }
        })
        if (!updated) throw new Error('Failed to update provider profile')
        return publicView(updated)
    }

    async setDefault(agent: AgentProvider, id: string | null): Promise<void> {
        await this.updateDocument((document) => {
            const store = this.getNamespace(document)
            if (id) {
                const profile = store.profiles.find((candidate) => candidate.id === id)
                if (!profile || profile.agent !== agent) throw new Error('Provider profile not found for this agent')
                if (!profile.enabled) throw new Error('Disabled provider profiles cannot be selected as default')
            }
            store.defaults[agent] = id
        })
    }

    async resolve(agent: AgentProvider, requestedId?: string | null): Promise<ResolvedProviderProfile | null> {
        if (requestedId === null) return null
        const store = this.getNamespace(await this.readDocument())
        const id = requestedId ?? store.defaults[agent]
        if (!id) return null
        const profile = store.profiles.find((candidate) => candidate.id === id && candidate.agent === agent)
        if (!profile) throw new Error('Selected provider profile no longer exists')
        if (!profile.enabled) throw new Error('Selected provider profile is disabled')
        return profile
    }

    async get(id: string): Promise<ResolvedProviderProfile | null> {
        const store = this.getNamespace(await this.readDocument())
        return store.profiles.find((profile) => profile.id === id) ?? null
    }

    async recordHealthCheck(id: string, result: ProviderHealthCheckResponse): Promise<ProviderProfileView> {
        let updated: StoredProfile | null = null
        await this.updateDocument((document) => {
            const store = this.getNamespace(document)
            const index = store.profiles.findIndex((profile) => profile.id === id)
            if (index === -1) throw new Error('Provider profile not found')
            const current = store.profiles[index]
            const discovered = result.models?.map((model) => ({
                ...parseProviderModelReference(model.id),
                source: 'provider' as const,
                refreshedAt: result.checkedAt
            })) ?? current.models.filter((model) => model.source === 'provider')
            const next: StoredProfile = {
                ...current,
                models: mergeModels(discovered, current.models.filter((model) => model.source === 'custom')),
                health: {
                    status: result.status,
                    checkedAt: result.checkedAt,
                    ...(result.error ? { error: result.error } : {})
                },
                revision: current.revision + 1,
                updatedAt: Date.now()
            }
            store.profiles[index] = next
            updated = next
        })
        if (!updated) throw new Error('Failed to update provider profile')
        return publicView(updated)
    }

    private getNamespace(document: ProviderDocument): NamespaceStore {
        const existing = document.namespaces[this.namespace]
        if (existing) return existing
        const created: NamespaceStore = { profiles: [], defaults: { ...EmptyDefaults } }
        document.namespaces[this.namespace] = created
        return created
    }

    private async readDocument(): Promise<ProviderDocument> {
        try {
            const value = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ProviderDocument>
            const document = emptyDocument()
            if (value.version !== 1 || !value.namespaces || typeof value.namespaces !== 'object') return document
            for (const [namespace, rawStore] of Object.entries(value.namespaces)) {
                if (!rawStore || typeof rawStore !== 'object') continue
                const candidate = rawStore as Partial<NamespaceStore>
                const profiles = z.array(StoredProfileSchema).safeParse(candidate.profiles)
                if (!profiles.success) continue
                document.namespaces[namespace] = {
                    profiles: profiles.data,
                    defaults: {
                        claude: typeof candidate.defaults?.claude === 'string' ? candidate.defaults.claude : null,
                        codex: typeof candidate.defaults?.codex === 'string' ? candidate.defaults.codex : null,
                        cursor: typeof candidate.defaults?.cursor === 'string' ? candidate.defaults.cursor : null,
                        grok: typeof candidate.defaults?.grok === 'string' ? candidate.defaults.grok : null,
                        kimi: typeof candidate.defaults?.kimi === 'string' ? candidate.defaults.kimi : null,
                        opencode: typeof candidate.defaults?.opencode === 'string' ? candidate.defaults.opencode : null,
                        pi: typeof candidate.defaults?.pi === 'string' ? candidate.defaults.pi : null
                    }
                }
            }
            return document
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument()
            throw new Error('Failed to read provider profiles')
        }
    }

    private async updateDocument(update: (document: ProviderDocument) => void): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        const lockPath = `${this.filePath}.lock`
        const tempPath = `${this.filePath}.${process.pid}.tmp`
        let lock: Awaited<ReturnType<typeof open>> | null = null
        for (let attempt = 0; attempt < 50; attempt += 1) {
            try {
                lock = await open(lockPath, 'wx', 0o600)
                break
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                try {
                    const lockInfo = await stat(lockPath)
                    if (Date.now() - lockInfo.mtimeMs > 10_000) {
                        await unlink(lockPath)
                        continue
                    }
                } catch {
                    // Lock disappeared between checks; retry immediately.
                }
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
        }
        if (!lock) throw new Error('Provider profile store is busy')

        try {
            const document = await this.readDocument()
            update(document)
            await writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600 })
            await chmod(tempPath, 0o600)
            await rename(tempPath, this.filePath)
            await chmod(this.filePath, 0o600)
        } finally {
            await lock.close()
            await unlink(lockPath).catch(() => {})
            await unlink(tempPath).catch(() => {})
        }
    }
}
