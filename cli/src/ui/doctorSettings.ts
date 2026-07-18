const SENSITIVE_DIAGNOSTIC_KEY = /token|secret|password|passphrase|private[_-]?key|authorization|cookie/i

const SAFE_SETTINGS_FIELDS = [
  ['machineId', 'string'],
  ['machineIdConfirmedByServer', 'boolean'],
  ['runnerAutoStartWhenRunningHappy', 'boolean'],
  ['apiUrl', 'string'],
  ['serverUrl', 'string'],
] as const

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function redactDiagnosticSecrets(value: unknown): JsonLike {
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticSecrets(item))
  }

  if (!isRecord(value)) {
    if (
      value === null
      || typeof value === 'boolean'
      || typeof value === 'number'
      || typeof value === 'string'
    ) {
      return value
    }
    return String(value)
  }

  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
    key,
    SENSITIVE_DIAGNOSTIC_KEY.test(key)
      ? '[REDACTED]'
      : redactDiagnosticSecrets(nestedValue),
  ]))
}

export function buildDoctorSettingsSummary(settings: unknown): Record<string, JsonLike> {
  if (!isRecord(settings)) {
    return {}
  }

  const allowlistedEntries = SAFE_SETTINGS_FIELDS.flatMap(([key, expectedType]) => {
    const value = settings[key]
    return typeof value === expectedType ? [[key, value] as const] : []
  })

  return redactDiagnosticSecrets(Object.fromEntries(allowlistedEntries)) as Record<string, JsonLike>
}
