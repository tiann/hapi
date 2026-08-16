import {
    getAgentConfigDescriptor,
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    resolveHapiYoloPermissionMode,
    type PermissionMode
} from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { usesCodexFamilyPermissionModes } from '@/lib/codexFamilyPermissionAgents'
import type { AgentType } from './types'
import { SelectControl } from '@/components/ui/select-control'
import { YoloToggle } from './YoloToggle'

export type PermissionFieldProps = {
    agent: AgentType
    /** Native permission mode for flavors rendered as a native-mode select. */
    nativeValue: PermissionMode
    yoloMode: boolean
    isDisabled: boolean
    autoPermissionModeSupported?: boolean | null
    onNativeChange: (value: PermissionMode) => void
    onYoloToggle: (value: boolean) => void
}

/**
 * Renders the Permission section of the create-session form from the agent's
 * configuration descriptor (see shared/src/agentConfig.ts).
 *
 * - `status` fields (Pi) surface a managed note instead of a control so the
 *   HAPI YOLO policy is never silently ignored for agents that cannot apply it.
 * - `select` fields render the agent's native permission modes.
 * - Flavors whose create surface still carries the persistent HAPI YOLO
 *   preference render the YOLO toggle with the native mode it maps to.
 */
export function PermissionField(props: PermissionFieldProps) {
    const { t } = useTranslation()
    const descriptor = getAgentConfigDescriptor(props.agent)
    const field = descriptor.fields.find((candidate) => candidate.id === 'permission')
    if (!field) {
        return null
    }

    if (field.kind === 'status') {
        return (
            <div className="flex flex-col gap-1.5 px-3 py-3" data-testid="permission-managed">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    {t('misc.permissionMode')}
                </label>
                <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-[var(--app-fg)]">
                        {t('newSession.permission.managedTitle')}
                    </span>
                    <span className="text-xs text-[var(--app-hint)]">
                        {t('newSession.permission.managedDesc')}
                    </span>
                </div>
            </div>
        )
    }

    if (field.kind === 'select' && (props.agent === 'grok' || usesCodexFamilyPermissionModes(props.agent))) {
        const options = getPermissionModeOptionsForFlavor(props.agent)
        return (
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    {t('misc.permissionMode')}
                </label>
                <SelectControl
                    value={props.nativeValue}
                    onChange={(event) => props.onNativeChange(event.target.value as PermissionMode)}
                    disabled={props.isDisabled}
                    className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                >
                    {options.map((option) => {
                        const unavailable = option.mode === 'auto'
                            && props.autoPermissionModeSupported === false
                        return (
                            <option key={option.mode} value={option.mode} disabled={unavailable}>
                                {option.label}{unavailable ? ` (${t('newSession.grokAutoUnavailable')})` : ''}
                            </option>
                        )
                    })}
                </SelectControl>
                {props.autoPermissionModeSupported === false ? (
                    <span className="text-xs text-[var(--app-hint)]">
                        {t('newSession.grokAutoUnavailableDesc')}
                    </span>
                ) : null}
            </div>
        )
    }

    // Remaining flavors still carry the persistent HAPI YOLO preference at
    // create time. The descriptor advertises the native modes their session
    // surface supports; surface the mapping so the preference is explicit.
    const nativeHint = resolveHapiYoloPermissionMode(props.agent)
    return (
        <YoloToggle
            yoloMode={props.yoloMode}
            isDisabled={props.isDisabled}
            onToggle={props.onYoloToggle}
            nativeHint={nativeHint ? getPermissionModeLabel(nativeHint) : undefined}
        />
    )
}
