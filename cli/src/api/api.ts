import axios from 'axios'
import type { AgentState, CreateMachineResponse, CreateSessionResponse, DaemonState, Machine, MachineMetadata, Metadata, Session } from '@/api/types'
import { AgentStateSchema, CreateMachineResponseSchema, CreateSessionResponseSchema, DaemonStateSchema, MachineMetadataSchema, MetadataSchema } from '@/api/types'
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
        tag: string
        metadata: Metadata
        state: AgentState | null
    }): Promise<Session> {
        const response = await axios.post<CreateSessionResponse>(
            `${configuration.serverUrl}/cli/sessions`,
            {
                tag: opts.tag,
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
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            agentState,
            agentStateVersion: raw.agentStateVersion
        }
    }

    async getOrCreateMachine(opts: {
        machineId: string
        metadata: MachineMetadata
        daemonState?: DaemonState
    }): Promise<Machine> {
        const response = await axios.post<CreateMachineResponse>(
            `${configuration.serverUrl}/cli/machines`,
            {
                id: opts.machineId,
                metadata: opts.metadata,
                daemonState: opts.daemonState ?? null
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

        const daemonState = (() => {
            if (raw.daemonState == null) return null
            const parsedDaemonState = DaemonStateSchema.safeParse(raw.daemonState)
            return parsedDaemonState.success ? parsedDaemonState.data : null
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
            daemonState,
            daemonStateVersion: raw.daemonStateVersion
        }
    }

    sessionSyncClient(session: Session): ApiSessionClient {
        return new ApiSessionClient(this.token, session)
    }

    machineSyncClient(machine: Machine): ApiMachineClient {
        return new ApiMachineClient(this.token, machine)
    }
}
