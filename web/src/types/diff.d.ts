declare module 'diff' {
    export type Change = {
        value: string
        added?: boolean
        removed?: boolean
    }

    export function diffLines(oldStr: string, newStr: string): Change[]
}

