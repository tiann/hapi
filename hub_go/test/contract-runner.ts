import { httpContracts } from './contracts/http-contracts.ts'
import { socketContracts } from './contracts/socket-contracts.ts'
import { sseContracts } from './contracts/sse-contracts.ts'
import { httpRecordings } from './contracts/http-recordings.ts'
import { sseRecordings } from './contracts/sse-recordings.ts'
import { sseSamples } from './contracts/sse-samples.ts'

const httpRecordingIndex = new Map<string, any[]>()
for (const recording of httpRecordings) {
    const key = `${recording.method} ${recording.path}`
    const entries = httpRecordingIndex.get(key) ?? []
    entries.push(recording)
    httpRecordingIndex.set(key, entries)
}

const sseRecordingIndex = new Map<string, any[]>()
for (const recording of sseRecordings) {
    const type = typeof recording.type === 'string' ? recording.type : 'unknown'
    const events = sseRecordingIndex.get(type) ?? []
    events.push(recording)
    sseRecordingIndex.set(type, events)
}

function recordError(errors: string[], message: string): void {
    errors.push(message)
}

function recordWarning(warnings: string[], message: string): void {
    warnings.push(message)
}

function pathMatches(template: string, actual: string): boolean {
    const actualPath = actual.split('?')[0]
    const tParts = template.split('/').filter(Boolean)
    const aParts = actualPath.split('/').filter(Boolean)
    if (tParts.length !== aParts.length) return false
    for (let i = 0; i < tParts.length; i += 1) {
        const t = tParts[i]
        const a = aParts[i]
        if (t.startsWith(':')) {
            if (!a) return false
            continue
        }
        if (t !== a) return false
    }
    return true
}

function findHttpRecordings(method: string, path: string): any[] {
    const exact = httpRecordingIndex.get(`${method} ${path}`)
    if (exact && exact.length) return exact
    const matches: any[] = []
    for (const recording of httpRecordings) {
        if (recording.method !== method) continue
        if (pathMatches(path, recording.path)) {
            matches.push(recording)
        }
    }
    return matches
}

function hasExpectedShape(value: any, expected: Record<string, any>): boolean {
    if (!value || typeof value !== 'object') {
        return false
    }
    for (const [key, shape] of Object.entries(expected)) {
        if (!(key in value)) {
            return false
        }
        if (shape == null) continue
        const expectedType = typeof shape
        if (expectedType === 'string' && typeof value[key] !== 'string') {
            return false
        }
        if (expectedType === 'number' && typeof value[key] !== 'number') {
            return false
        }
        if (expectedType === 'boolean' && typeof value[key] !== 'boolean') {
            return false
        }
    }
    return true
}

function checkObjectShape(errors: string[], value: any, expected: Record<string, any>, context: string): void {
    if (!value || typeof value !== 'object') {
        recordError(errors, `${context}: expected object`)
        return
    }
    for (const [key, shape] of Object.entries(expected)) {
        if (!(key in value)) {
            recordError(errors, `${context}: missing key ${key}`)
            continue
        }
        if (shape == null) continue
        const expectedType = typeof shape
        if (expectedType === 'string' && typeof value[key] !== 'string') {
            recordError(errors, `${context}: key ${key} expected string`)
        }
        if (expectedType === 'number' && typeof value[key] !== 'number') {
            recordError(errors, `${context}: key ${key} expected number`)
        }
        if (expectedType === 'boolean' && typeof value[key] !== 'boolean') {
            recordError(errors, `${context}: key ${key} expected boolean`)
        }
    }
}

function validateHttpContracts(warnings: string[]): string[] {
    const errors: string[] = []

    for (const contract of httpContracts) {
        const key = `${contract.method} ${contract.path}`
        const recordings = findHttpRecordings(contract.method, contract.path)
        if (recordings.length === 0) {
            recordWarning(warnings, `HTTP missing recording: ${key}`)
            continue
        }
        if (contract.response.body === null) {
            continue
        }
        const matching = recordings.find((recording) => {
            const response = recording.response ?? {}
            return hasExpectedShape(response.body, contract.response.body)
        })
        if (!matching) {
            const sample = recordings[0]
            const response = sample?.response ?? {}
            if (response?.body && typeof response.body === 'object' && 'error' in response.body) {
                recordWarning(warnings, `HTTP ${key}: only error recordings available`)
                continue
            }
            if (typeof response.status !== 'number') {
                recordWarning(warnings, `HTTP ${key}: recording missing status`)
                continue
            }
            if (response.body === null || response.body === undefined) {
                recordWarning(warnings, `HTTP ${key}: recording missing body`)
                continue
            }
            checkObjectShape(errors, response.body, contract.response.body, `HTTP ${key}`)
        }
    }

    return errors
}

function validateSocketContracts(): string[] {
    const errors: string[] = []

    const clientEvents = socketContracts.filter((contract) => contract.direction === 'client->server')
    const serverEvents = socketContracts.filter((contract) => contract.direction === 'server->client')

    if (clientEvents.length === 0) {
        recordError(errors, 'Socket contracts: no client->server events')
    }
    if (serverEvents.length === 0) {
        recordError(errors, 'Socket contracts: no server->client events')
    }

    for (const contract of socketContracts) {
        if (!contract.namespace) {
            recordError(errors, `Socket contract missing namespace for event ${contract.event}`)
        }
        if (!contract.event) {
            recordError(errors, 'Socket contract missing event name')
        }
    }

    return errors
}

function validateSSEContracts(warnings: string[]): string[] {
    const errors: string[] = []

    for (const contract of sseContracts) {
        const recordings = sseRecordingIndex.get(contract.type) ?? []
        const samples = sseSamples.filter((sample) => sample.type === contract.type)
        if (recordings.length === 0 && samples.length === 0) {
            recordWarning(warnings, `SSE missing recording or sample for ${contract.type}`)
            continue
        }

        const example = recordings[0] ?? samples[0]
        const payload = example
        for (const [key, spec] of Object.entries(contract.fields)) {
            if (!spec.optional && !(key in payload)) {
                recordWarning(warnings, `SSE ${contract.type}: missing field ${key}`)
            }
        }
    }

    return errors
}

function main(): void {
    const warnings: string[] = []
    const errors = [
        ...validateHttpContracts(warnings),
        ...validateSocketContracts(),
        ...validateSSEContracts(warnings)
    ]

    if (warnings.length) {
        console.warn('Contract warnings:')
        for (const warning of warnings) {
            console.warn(`- ${warning}`)
        }
    }

    if (errors.length) {
        console.error('Contract checks failed:')
        for (const error of errors) {
            console.error(`- ${error}`)
        }
        process.exit(1)
    }

    if (process.env.CONTRACT_STRICT === '1' && warnings.length) {
        process.exit(1)
    }

    console.log('Contract checks passed')
}

main()
