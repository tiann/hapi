type GitEnvironment = Record<string, string | undefined>

export function createGitHubAuthEnv(baseEnv: Readonly<GitEnvironment>, token: string): GitEnvironment {
    const rawCount = baseEnv.GIT_CONFIG_COUNT ?? '0'
    if (!/^\d+$/.test(rawCount)) {
        throw new Error('GIT_CONFIG_COUNT must be a non-negative integer')
    }

    const index = Number(rawCount)
    const basicCredential = Buffer.from(`x-access-token:${token}`).toString('base64')

    return {
        ...baseEnv,
        GIT_CONFIG_COUNT: String(index + 1),
        [`GIT_CONFIG_KEY_${index}`]: 'http.https://github.com/.extraheader',
        [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${basicCredential}`
    }
}
