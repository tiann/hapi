export type AuthResponse = {
    token: string
    user: {
        id: number
        username?: string
        firstName?: string
        lastName?: string
    }
}

export type AuthSource =
    | { type: 'accessToken'; token: string }
