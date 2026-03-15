// Widgets 层导出
// Widgets 是页面上的大块独立区域，组合多个 features 形成完整功能模块

export { SystemStatus } from './system-status'
export type { SystemStatusProps } from './system-status'

export { LoginGate } from './login-gate'
export type { LoginGateProps } from './login-gate'

export { SessionHeader } from './session-header'
export type { SessionHeaderProps, GitSummary, SessionHeaderView } from './session-header'

export { SessionListPanel, groupSessionsByDirectory } from './session-list-panel'
export type { SessionListPanelProps, SessionGroup } from './session-list-panel'

export { SessionFilesPanel } from './session-files-panel'
export type { SessionFilesPanelProps } from './session-files-panel'

export { SessionTerminalPanel } from './session-terminal-panel'
export type { SessionTerminalPanelProps } from './session-terminal-panel'

export { SessionChatPanel } from './session-chat-panel'
export type { SessionChatPanelProps } from './session-chat-panel'
