import { HAPI_PLUGIN_API_VERSION, type PluginManifestLite } from './manifest'
import { getBundledPluginsRoot, prepareBundledPlugins, type BundledPlugin } from './bundledMaterialize'

export const HAPI_BUNDLED_EXAMPLE_PLUGINS_DIR = 'bundled-example-plugins'

export type BundledExamplePlugin = BundledPlugin

function manifestBase(manifest: Omit<PluginManifestLite, 'pluginApiVersion' | 'version'> & { version?: string }): PluginManifestLite {
    return {
        ...manifest,
        version: manifest.version ?? '0.1.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION
    }
}

const notificationLoggerHub = `export function activate(ctx) {
    const prefix = String(ctx.config.get('prefix') ?? '[hapi-example-notification]');
    ctx.notifications.registerChannel({
        async send(event) {
            ctx.logger.info(\`\${prefix} \${event.type} session=\${event.session.id} agent=\${event.session.agent ?? 'unknown'}\`);
        }
    });
}
`

const runnerEnvironmentRuntime = `export function activate(ctx) {
    const envValue = String(ctx.config.get('envValue') ?? 'enabled');
    ctx.runtime.registerEnvironmentProvider({
        id: 'example-environment',
        priority: 20,
        provide(context) {
            return {
                env: { EXAMPLE_RUNNER_ENV: envValue },
                diagnostics: [{
                    severity: 'info',
                    code: 'example-runner-environment',
                    message: \`Example runner environment applied for \${context.agent}\`
                }]
            };
        }
    });
    ctx.runtime.registerSpawnHook({
        id: 'example-spawn-audit',
        priority: 20,
        beforeSpawn(context) {
            return {
                diagnostics: [{
                    severity: 'info',
                    code: 'example-runner-spawn-audit',
                    message: \`Example spawn audit observed \${context.agent} in \${context.cwd}\`
                }]
            };
        }
    });
}
`

const echoAgentRuntime = `function createEchoBackend() {
    let permissionHandler = () => undefined;
    return {
        async initialize() {},
        async newSession() {
            return \`example-echo-\${Date.now()}\`;
        },
        async prompt(sessionId, content, onUpdate) {
            const text = content.map((entry) => entry && entry.type === 'text' ? entry.text : '').filter(Boolean).join('\\n').trim();
            onUpdate({ type: 'reasoning', text: 'Example Echo Agent is a bundled plugin used to validate dynamic agent adapters.' });
            onUpdate({ type: 'text', text: \`Echo from \${sessionId}: \${text || '(empty prompt)'}\` });
            onUpdate({ type: 'turn_complete', stopReason: 'completed' });
        },
        async cancelPrompt() {},
        async respondToPermission() {},
        onPermissionRequest(handler) {
            permissionHandler = typeof handler === 'function' ? handler : permissionHandler;
        },
        async disconnect() {}
    };
}

export function activate(ctx) {
    ctx.runtime.registerAgentAdapter({
        id: 'example-echo-agent',
        descriptor: {
            id: 'example:echo',
            displayName: 'Example Echo Agent',
            description: 'A bundled plugin-backed agent that echoes prompts.',
            adapter: {
                runtime: 'runner',
                kind: 'custom-runner-plugin',
                contributionId: 'example-echo-agent'
            },
            capabilities: {
                supportsResume: false,
                supportsPlanMode: false,
                supportsFileContext: false,
                permissionModes: ['default', 'yolo'],
                models: ['echo-small']
            }
        },
        createBackend: createEchoBackend
    });
    ctx.runtime.registerAgentCapabilityProvider({
        id: 'example-echo-capabilities',
        agentId: 'example:echo',
        provide() {
            return {
                models: [{ id: 'echo-large', displayName: 'Echo Large', contextWindow: 8000 }],
                permissionModes: [{ mode: 'yolo', label: 'Example YOLO', risk: 'danger' }],
                profiles: [{ id: 'concise', displayName: 'Concise echo' }],
                sessions: [{ id: 'example-native-session', title: 'Example native session', importable: true }],
                usage: [{ scope: 'agent', totalTokens: 42, limitLabel: 'example quota' }],
                skills: [{ name: 'echo-review', description: 'Echo a review checklist.' }],
                slashCommands: [{ name: 'echo', description: 'Echo the current prompt.' }]
            };
        },
        importHistory() {
            return {
                messages: [
                    { role: 'user', content: 'Imported example prompt', createdAt: 1 },
                    { role: 'agent', content: 'Imported example response', createdAt: 2 }
                ]
            };
        }
    });
}
`

const spawnPolicyRuntime = `export function activate(ctx) {
    ctx.runtime.registerSpawnHook({
        id: 'example-spawn-policy',
        priority: -10,
        beforeSpawn(context) {
            const blockedAgent = ctx.config.get('blockedAgent');
            if (typeof blockedAgent === 'string' && blockedAgent && context.agent === blockedAgent) {
                return {
                    block: { reason: \`Example policy blocked agent \${context.agent}\` },
                    diagnostics: [{
                        severity: 'warning',
                        code: 'example-policy-blocked',
                        message: \`Example policy blocked \${context.agent}\`
                    }]
                };
            }
            return {
                diagnostics: [{
                    severity: 'info',
                    code: 'example-policy-checked',
                    message: \`Example policy allowed \${context.agent}\`
                }]
            };
        }
    });
}
`

const crossRuntimeHub = `export function activate(ctx) {
    ctx.messages.registerAction({
        id: 'example-cross-runtime',
        kind: 'chat.composer.messageAction',
        async plan() {
            return { ok: true, plan: { type: 'immediate' } };
        }
    });
}
`

const crossRuntimeRunner = `export function activate(ctx) {
    ctx.actions.register({
        id: 'example-cross-runtime-context',
        kind: 'chat.composer.messageAction',
        run(input) {
            return {
                ok: true,
                result: {
                    text: \`Example runner context for \${input.cwd ?? input.sessionId ?? 'unknown session'}\`
                }
            };
        }
    });
}
`

export const bundledExamplePlugins: BundledExamplePlugin[] = [
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.notification-logger',
            name: 'Example Notification Logger',
            description: 'Logs notification events through the Hub plugin notification channel extension point.',
            runtimes: { hub: { entry: 'dist/hub.js' } },
            contributions: {
                hub: {
                    notificationChannels: [{ id: 'logger', displayName: 'Example Logger' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'notification-logger',
                        title: 'Example Notification Logger',
                        description: 'Hub runtime sample for outbound notification channels.',
                        components: [
                            { kind: 'text', text: 'Enable this plugin on the Hub target to log notification events.' },
                            {
                                kind: 'schemaForm',
                                title: 'Logger options',
                                fields: [{ key: 'prefix', label: 'Log prefix', type: 'text', defaultValue: '[hapi-example-notification]' }]
                            }
                        ]
                    }]
                }
            }
        }),
        files: [{ path: 'dist/hub.js', content: notificationLoggerHub }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.runner-environment',
            name: 'Example Runner Environment',
            description: 'Adds a visible environment variable and spawn audit diagnostic in the Runner runtime.',
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: {
                runner: {
                    environmentProviders: [{ id: 'example-environment', displayName: 'Example Environment Provider' }],
                    spawnHooks: [{ id: 'example-spawn-audit', displayName: 'Example Spawn Audit' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'runner-environment',
                        title: 'Example Runner Environment',
                        components: [
                            { kind: 'text', text: 'Enable on a Runner target to set EXAMPLE_RUNNER_ENV for spawned sessions.' },
                            {
                                kind: 'schemaForm',
                                title: 'Environment options',
                                fields: [{ key: 'envValue', label: 'Environment value', type: 'text', defaultValue: 'enabled' }]
                            }
                        ]
                    }]
                }
            }
        }),
        files: [{ path: 'dist/runner.js', content: runnerEnvironmentRuntime }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.echo-agent',
            name: 'Example Echo Agent',
            description: 'Registers a plugin-backed echo agent and capability provider.',
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: {
                agent: {
                    adapters: [{ id: 'example-echo-agent', displayName: 'Example Echo Agent Adapter' }],
                    capabilityProviders: [{ id: 'example-echo-capabilities', displayName: 'Example Echo Capabilities' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'echo-agent',
                        title: 'Example Echo Agent',
                        components: [
                            { kind: 'text', text: 'Enable on a Runner target, then choose Example Echo Agent in New Session.' },
                            { kind: 'badge', label: 'Agent adapter + capability provider', variant: 'success' }
                        ]
                    }],
                    newSessionFields: [{
                        id: 'echo-prefix',
                        key: 'echoPrefix',
                        label: 'Echo prefix',
                        description: 'Example agent-specific new session field.',
                        agentIds: ['example:echo'],
                        type: 'text',
                        defaultValue: 'Echo'
                    }]
                }
            }
        }),
        files: [{ path: 'dist/runner.js', content: echoAgentRuntime }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.cross-runtime-action',
            name: 'Example Cross Runtime Action',
            description: 'Demonstrates one capability assembled from Web descriptor, Hub message action, and Runner action parts.',
            capabilities: [{
                id: 'example-cross-runtime',
                kind: 'chat.composer.messageAction',
                displayName: 'Example Cross Runtime Action',
                description: 'Shows how a single capability can require Web, Hub, and Runner parts before becoming ready.',
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'composerAction', id: 'example-cross-runtime' }]
                    },
                    hub: {
                        required: true,
                        contributions: [{ type: 'messageAction', id: 'example-cross-runtime' }]
                    },
                    runner: {
                        required: true,
                        target: 'session-runner',
                        contributions: [{ type: 'action', id: 'example-cross-runtime-context' }]
                    }
                }
            }],
            runtimes: {
                hub: { entry: 'dist/hub.js' },
                runner: { entry: 'dist/runner.js' }
            },
            contributions: {
                hub: {
                    messageActions: [{
                        id: 'example-cross-runtime',
                        displayName: 'Example Cross Runtime Action',
                        description: 'Example Hub message-action handler for a cross-runtime capability.'
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'cross-runtime-action',
                        title: 'Example Cross Runtime Action',
                        components: [
                            { kind: 'text', text: 'Enable this plugin on Hub and the session Runner to make the capability ready.', tone: 'info' },
                            { kind: 'badge', label: 'Web + Hub + Runner', variant: 'success' }
                        ]
                    }],
                    composerActions: [{
                        id: 'example-cross-runtime',
                        kind: 'pluginMessageAction',
                        capabilityId: 'example-cross-runtime',
                        label: 'Example cross-runtime action',
                        description: 'Descriptor for a capability whose readiness depends on Hub and Runner handlers.',
                        icon: 'clock',
                        handler: { position: 'hub', actionId: 'example-cross-runtime' },
                        ui: {
                            kind: 'confirm',
                            title: 'Run example cross-runtime action',
                            body: 'This example demonstrates capability readiness; it sends immediately.'
                        }
                    }]
                }
            }
        }),
        files: [
            { path: 'dist/hub.js', content: crossRuntimeHub },
            { path: 'dist/runner.js', content: crossRuntimeRunner }
        ]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.spawn-policy',
            name: 'Example Spawn Policy',
            description: 'Runner spawn policy sample that can block a configured agent.',
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: {
                runner: {
                    spawnHooks: [{ id: 'example-spawn-policy', displayName: 'Example Spawn Policy' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'spawn-policy',
                        title: 'Example Spawn Policy',
                        components: [
                            { kind: 'text', text: 'Set blockedAgent to demonstrate a policy hook that can block spawn.' },
                            {
                                kind: 'schemaForm',
                                title: 'Policy options',
                                fields: [{ key: 'blockedAgent', label: 'Blocked agent id', type: 'text' }]
                            }
                        ]
                    }]
                }
            }
        }),
        files: [{ path: 'dist/runner.js', content: spawnPolicyRuntime }]
    }
]

export function getBundledExamplePluginsRoot(hapiHome: string): string {
    return getBundledPluginsRoot(hapiHome, HAPI_BUNDLED_EXAMPLE_PLUGINS_DIR)
}

export async function prepareBundledExamplePlugins(hapiHome: string): Promise<string> {
    return await prepareBundledPlugins({
        hapiHome,
        directoryName: HAPI_BUNDLED_EXAMPLE_PLUGINS_DIR,
        plugins: bundledExamplePlugins,
        label: 'bundled example'
    })
}
