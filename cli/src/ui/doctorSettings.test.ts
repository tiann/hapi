import { describe, expect, it } from 'vitest'
import {
  buildDoctorSettingsSummary,
  redactDiagnosticSecrets,
} from './doctorSettings'

describe('doctor settings diagnostics', () => {
  it('only emits allowlisted non-secret settings fields', () => {
    const summary = buildDoctorSettingsSummary({
      machineId: 'machine-123',
      machineIdConfirmedByServer: true,
      runnerAutoStartWhenRunningHappy: false,
      apiUrl: 'https://hapi.example.test',
      serverUrl: 'https://legacy.example.test',
      cliApiToken: 'cli-token-secret',
      vapidKeys: {
        publicKey: 'vapid-public',
        privateKey: 'vapid-private-secret',
      },
      telegramBotToken: 'telegram-secret',
      futureSecretContainer: {
        password: 'future-password',
      },
    })

    expect(summary).toEqual({
      machineId: 'machine-123',
      machineIdConfirmedByServer: true,
      runnerAutoStartWhenRunningHappy: false,
      apiUrl: 'https://hapi.example.test',
      serverUrl: 'https://legacy.example.test',
    })

    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('cli-token-secret')
    expect(serialized).not.toContain('vapid-private-secret')
    expect(serialized).not.toContain('telegram-secret')
    expect(serialized).not.toContain('future-password')
    expect(serialized).not.toContain('cliApiToken')
    expect(serialized).not.toContain('privateKey')
  })

  it('recursively redacts sensitive keys as a defense in depth', () => {
    expect(redactDiagnosticSecrets({
      visible: 'safe',
      nested: [{
        accessToken: 'access-secret',
        private_key: 'private-secret',
        password: 'password-secret',
        authorization: 'Bearer authorization-secret',
        cookie: 'session=cookie-secret',
      }],
    })).toEqual({
      visible: 'safe',
      nested: [{
        accessToken: '[REDACTED]',
        private_key: '[REDACTED]',
        password: '[REDACTED]',
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
      }],
    })
  })
})
