export type RecordedProcessGroupEvidence = {
    complete: boolean
    members: readonly unknown[]
}

export async function proveRecordedProcessGroupEmpty(options: {
    leasePgid?: number | null
    launchPgid?: number | null
    readGroup(pgid: number): Promise<RecordedProcessGroupEvidence>
}): Promise<boolean> {
    const pgid = options.leasePgid ?? options.launchPgid ?? null
    if (!pgid) return false

    try {
        const evidence = await options.readGroup(pgid)
        return evidence.complete && evidence.members.length === 0
    } catch {
        return false
    }
}
