import { parseProviderModelReference } from '@hapi/protocol'

/**
 * `[1M]` is HAPI's session-selection marker, not part of a compatible
 * provider's model identifier. Native Claude presets keep their suffixes;
 * managed provider profiles are the only launches that strip the marker.
 */
export function resolveManagedProviderWireModel(model: string | null | undefined): string | null | undefined {
    if (!model || !process.env.HAPI_PROVIDER_PROFILE_ID || !/\[1m\]\s*$/i.test(model)) {
        return model
    }
    return parseProviderModelReference(model).id
}
