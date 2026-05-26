export const HUB_IMPLEMENTED_EXTENSION_POINTS = [
    'hub.notificationChannel',
    'hub.messageAction',
    'web.settingsPanel',
    'web.newSessionField',
    'web.action',
    'web.badge',
    'web.composerAction'
] as const

export const RUNNER_IMPLEMENTED_EXTENSION_POINTS = [
    'runner.spawnOptionsProvider',
    'runner.environmentProvider',
    'runner.commandResolver',
    'runner.spawnHook',
    'runner.action',
    'agent.adapter',
    'agent.capabilityProvider',
    'web.settingsPanel',
    'web.newSessionField',
    'web.action',
    'web.badge',
    'web.composerAction'
] as const

export const SCHEMA_ONLY_EXTENSION_POINTS = [
    'chat.contextProvider',
    'voice.provider',
    'deployment.pack',
    'integration.protocolBridge'
] as const

export type HubImplementedExtensionPoint = typeof HUB_IMPLEMENTED_EXTENSION_POINTS[number]
export type RunnerImplementedExtensionPoint = typeof RUNNER_IMPLEMENTED_EXTENSION_POINTS[number]
export type SchemaOnlyExtensionPoint = typeof SCHEMA_ONLY_EXTENSION_POINTS[number]
