const TELEMETRY_ERROR_MARKERS = [
    'BatchSpanProcessor.ExportError',
    'HTTP export failed'
] as const;

const GROK_BUILD_SUBSCRIPTION_ERROR_MARKERS = [
    'responses API error',
    '403 Forbidden',
    "The model 'grok-build' requires a Grok subscription"
] as const;

export function shouldSurfaceGrokStderr(message: string): boolean {
    const isTelemetryExportFailure = TELEMETRY_ERROR_MARKERS.every((marker) => message.includes(marker));
    const isNonFatalGrokBuildSubscriptionError = GROK_BUILD_SUBSCRIPTION_ERROR_MARKERS
        .every((marker) => message.includes(marker));
    return !isTelemetryExportFailure && !isNonFatalGrokBuildSubscriptionError;
}
