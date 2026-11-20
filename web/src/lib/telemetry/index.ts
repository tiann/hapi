import type { TelemetryDomain, TelemetryLevel } from '@hapi/protocol/telemetry'
import { getOrCreateDeviceId } from './device'
import { installGlobalHandlers, uninstallGlobalHandlers } from './installers'
import { startNegotiation } from './negotiate'
import { readOutbox } from './outbox'
import { captureEvent } from './queue'
import { resetTelemetryState, state, type TelemetryCaptureOpts } from './state'

export { TelemetryErrorBoundary } from './ErrorBoundary'

/**
 * hapi web 遥测 SDK 公共面(详细日志模式 P0)。
 *
 * - `capture` 入队(SDK 自动补 id/ts/seq/device/level=TELEMETRY_KINDS[kind].minLevel;
 *   未安装 / 等级不足 / 旧 hub(无能力位)→ 静默 no-op);
 * - `setTrigger`/`getTrigger` ux 归因(fetch 包装读当前值落到 http 行 trigger 列,不设=null);
 * - `getLevel` 当前协商等级(0=关/未安装)。
 *
 * 集成(main.tsx):installTelemetry 最早调用;dev(import.meta.env.DEV)整机 no-op。
 * JWT 只存在于 React(useAuth)内部,main.tsx 拿不到 —— SDK 的 token 来源是
 * authProxy 单点观测到的 Bearer 头(httpObserver.noteBearerFromHeaders),
 * token 刷新自动跟上;getAuthToken 保留给未来有全局 token 商店的调用方优先。
 */

export type { TelemetryCaptureOpts }

export interface TelemetryApi {
    /** 入队事件(SDK 自动补 id/ts/seq/device/level=TELEMETRY_KINDS[kind].minLevel;未安装/等级不足/旧 hub=静默 no-op) */
    capture(domain: TelemetryDomain, kind: string, data: Record<string, unknown>, opts?: TelemetryCaptureOpts): void
    /** ux 归因:设置当前 trigger(session-open/send/prefetch/...),fetch 包装读取落到 http 行 trigger 列;不设=null */
    setTrigger(trigger: string | null): void
    getTrigger(): string | null
    getLevel(): 0 | 1 | 2 | 3
}

export const telemetry: TelemetryApi = {
    capture(domain, kind, data, opts) {
        captureEvent(domain, kind, data, opts)
    },
    setTrigger(trigger) {
        try {
            state.trigger = typeof trigger === 'string' ? trigger : null
        } catch {
            // fail-silent
        }
    },
    getTrigger() {
        return state.trigger
    },
    getLevel() {
        return state.level
    },
}

export function installTelemetry(config: { getAuthToken: () => string | null; baseUrl: string }): void {
    try {
        if (import.meta.env.DEV && !state.forced) return
        state.config = {
            getAuthToken: () => {
                try {
                    return config.getAuthToken()
                } catch {
                    return null
                }
            },
            baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        }
        if (state.installed) return // re-install = config refresh (hub switch)
        state.installed = true
        state.deviceId = getOrCreateDeviceId()
        // Seed the monotonic seq above anything the outbox holds so redelivered
        // events keep ordering hints meaningful across reloads.
        state.seq = readOutbox().events.reduce((max, ev) => Math.max(max, ev.seq), -1) + 1
        installGlobalHandlers()
        startNegotiation()
    } catch {
        state.installed = false
    }
}

/** Full teardown — used by tests and safe to call when never installed. */
export function uninstallTelemetry(): void {
    try {
        uninstallGlobalHandlers()
    } catch {
        // fail-silent
    }
    for (const key of ['retryTimer', 'ageTimer', 'probeTimer'] as const) {
        const timer = state[key]
        if (timer !== null) {
            try {
                clearTimeout(timer)
            } catch {
                // fail-silent
            }
        }
    }
    resetTelemetryState()
}

export type { TelemetryDomain, TelemetryLevel }
