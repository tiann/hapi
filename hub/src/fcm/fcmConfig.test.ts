import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { resolveFcmConfig } from './fcmConfig'

const tempDirs: string[] = []
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function makeServiceAccountFile(
    contents: object,
    baseDir: string = tmpdir()
): string {
    const dir = mkdtempSync(join(baseDir, 'hapi-fcm-sa-'))
    tempDirs.push(dir)
    const path = join(dir, 'service-account.json')
    writeFileSync(path, JSON.stringify(contents))
    return path
}

const VALID_ACCOUNT = {
    project_id: 'proj-1',
    client_email: 'svc@proj-1.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n'
}

describe('resolveFcmConfig', () => {
    it('returns null when no path is configured', () => {
        expect(resolveFcmConfig({ fcmServiceAccountPath: null })).toBeNull()
        expect(resolveFcmConfig({ fcmServiceAccountPath: '   ' })).toBeNull()
    })

    it('returns null when the configured file does not exist', () => {
        expect(resolveFcmConfig({ fcmServiceAccountPath: '/nonexistent/sa.json' })).toBeNull()
    })

    it('loads the service account and takes the project id from the JSON', () => {
        const path = makeServiceAccountFile(VALID_ACCOUNT)
        const config = resolveFcmConfig({ fcmServiceAccountPath: path })
        expect(config).not.toBeNull()
        expect(config?.projectId).toBe('proj-1')
        expect(config?.serviceAccountPath).toBe(path)
        expect(config?.serviceAccount.client_email).toBe(VALID_ACCOUNT.client_email)
    })

    it('returns null when the JSON has no project_id', () => {
        const path = makeServiceAccountFile({
            client_email: VALID_ACCOUNT.client_email,
            private_key: VALID_ACCOUNT.private_key
        })
        expect(resolveFcmConfig({ fcmServiceAccountPath: path })).toBeNull()
    })

    it('expands ~ in the configured path', () => {
        const path = makeServiceAccountFile(VALID_ACCOUNT, homedir())
        const config = resolveFcmConfig({
            fcmServiceAccountPath: `~/${relative(homedir(), path)}`
        })
        expect(config?.projectId).toBe('proj-1')
        expect(config?.serviceAccountPath).toBe(path)
    })
})
