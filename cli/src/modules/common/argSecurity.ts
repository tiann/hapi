const BLOCKED_RIPGREP_FLAGS = new Set([
    '--pre',
    '--config',
    '--config-path',
    '--type-add'
])

const BLOCKED_DIFFTASTIC_FLAGS = new Set<string>()

type ValidationResult = {
    valid: boolean
    error?: string
}

function isBlockedFlag(arg: string, blockedFlags: Set<string>): boolean {
    for (const flag of blockedFlags) {
        if (arg === flag || arg.startsWith(`${flag}=`)) {
            return true
        }
    }
    return false
}

function validateArgs(args: string[], blockedFlags: Set<string>): ValidationResult {
    for (const arg of args) {
        if (isBlockedFlag(arg, blockedFlags)) {
            return { valid: false, error: `Blocked flag: ${arg.split('=')[0]}` }
        }
    }
    return { valid: true }
}

export function validateRipgrepArgs(args: string[]): ValidationResult {
    return validateArgs(args, BLOCKED_RIPGREP_FLAGS)
}

export function validateDifftasticArgs(args: string[]): ValidationResult {
    return validateArgs(args, BLOCKED_DIFFTASTIC_FLAGS)
}
