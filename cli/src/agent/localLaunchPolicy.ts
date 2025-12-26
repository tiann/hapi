export type StartedBy = 'daemon' | 'terminal';

export type LocalLaunchExitReason = 'switch' | 'exit';

export type LocalLaunchContext = {
    startedBy?: StartedBy;
    startingMode?: 'local' | 'remote';
};

export function getLocalLaunchExitReason(context: LocalLaunchContext): LocalLaunchExitReason {
    if (context.startedBy === 'daemon' || context.startingMode === 'remote') {
        return 'switch';
    }

    return 'exit';
}
