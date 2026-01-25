import axios from 'axios'
import type { AgentState, CreateMachineResponse, CreateSessionResponse, RunnerState, Machine, MachineMetadata, Metadata, Session } from '@/api/types'
import { AgentStateSchema, CreateMachineResponseSchema, CreateSessionResponseSchema, RunnerStateSchema, MachineMetadataSchema, MetadataSchema } from '@/api/types'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { ApiMachineClient } from './apiMachine'
import { ApiSessionClient } from './apiSession'

export class ApiClient {
    static async create(): Promise<ApiClient> {
        return new ApiClient(getAuthToken())
    }

    private constructor(private readonly token: string) { }

    async getOrCreateSession(opts: {
        id: string | null
        metadata: Metadata
        state: AgentState | null
    }): Promise<Session> {
        const response = await axios.post<CreateSessionResponse>(
            `${configuration.apiUrl}/cli/sessions`,
            {
                id: opts.id,
                metadata: opts.metadata,
                agentState: opts.state
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const parsed = CreateSessionResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw new Error('Invalid /cli/sessions response')
        }

        const raw = parsed.data.session

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const agentState = (() => {
            if (raw.agentState == null) return null
            const parsedAgentState = AgentStateSchema.safeParse(raw.agentState)
            return parsedAgentState.success ? parsedAgentState.data : null
        })()

        return {
            id: raw.id,
            namespace: raw.namespace,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            agentState,
            agentStateVersion: raw.agentStateVersion,
            thinking: raw.thinking,
            thinkingAt: raw.thinkingAt,
            todos: raw.todos,
            permissionMode: raw.permissionMode,
            modelMode: raw.modelMode
        }
    }

    async getOrCreateMachine(opts: {
        machineId: string
        metadata: MachineMetadata
        runnerState?: RunnerState
    }): Promise<Machine> {
        const response = await axios.post<CreateMachineResponse>(
            `${configuration.apiUrl}/cli/machines`,
            {
                id: opts.machineId,
                metadata: opts.metadata,
                runnerState: opts.runnerState ?? null
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const parsed = CreateMachineResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw new Error('Invalid /cli/machines response')
        }

        const raw = parsed.data.machine

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MachineMetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const runnerState = (() => {
            if (raw.runnerState == null) return null
            const parsedRunnerState = RunnerStateSchema.safeParse(raw.runnerState)
            return parsedRunnerState.success ? parsedRunnerState.data : null
        })()

        return {
            id: raw.id,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            runnerState,
            runnerStateVersion: raw.runnerStateVersion
        }
    }

    sessionSyncClient(session: Session): ApiSessionClient {
        return new ApiSessionClient(this.token, session)
    }

    machineSyncClient(machine: Machine): ApiMachineClient {
        return new ApiMachineClient(this.token, machine)
    }
}
