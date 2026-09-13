let autoBridgeTransientModelErrors = false;

export function setAutoBridgeTransientModelErrors(enabled: boolean): void {
    autoBridgeTransientModelErrors = enabled;
}

export function getAutoBridgeTransientModelErrors(): boolean {
    return autoBridgeTransientModelErrors;
}
