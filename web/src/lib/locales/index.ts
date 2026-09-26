import enBase from './en'
import zhCNBase from './zh-CN'
import { terminalManagementEn, terminalManagementZhCN } from './terminal-management'

export const en = { ...enBase, ...terminalManagementEn }
export const zhCN = { ...zhCNBase, ...terminalManagementZhCN }
