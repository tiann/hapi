export default {
  // Loading states
  'loading': '加载中…',
  'authorizing': '认证中…',
  'loading.session': '加载会话…',
  'loading.git': '加载 Git 状态…',
  'loading.files': '加载文件…',
  'loading.messages': '加载消息…',
  'loading.machines': '加载机器…',

  // Login / Auth
  'login.title': 'HAPI',
  'login.subtitle': '随时随地，Vibe Coding',
  'login.bind.title': '绑定 Telegram',
  'login.submit': '登录',
  'login.bind.submit': '绑定',
  'login.submitting': '登录中…',
  'login.bind.submitting': '绑定中…',
  'login.placeholder': '访问令牌',
  'login.error.enterToken': '请输入访问令牌',
  'login.error.bindingUnavailable': '绑定服务不可用。',
  'login.error.loginUnavailable': '登录服务不可用。',
  'login.error.bindFailed': '绑定失败',
  'login.error.authFailed': '认证失败',
  'login.help': '需要帮助？',
  'login.server.default': '(默认)',
  'login.server.custom': '(自定义)',
  'login.server.title': '服务器地址',
  'login.server.description': '设置 HAPI 服务器地址以使用 API 和实时更新。',
  'login.server.current': '当前：',
  'login.server.origin': '服务器地址',
  'login.server.placeholder': 'https://hapi.example.com',
  'login.server.hint': '仅使用 http(s) 协议。任何路径将被忽略。',
  'login.server.useSameOrigin': '使用同源',
  'login.server.save': '保存',
  'login.footer': '用',
  'login.footer.for': '设计，Vibe Coding',
  'login.footer.copyright': '©',

  // Sessions page
  'sessions.count': '{n} 个会话，{m} 个项目',
  'sessions.new': '新建会话',

  // Session list
  'session.item.path': '路径',
  'session.item.agent': '代理',
  'session.item.model': '模型',
  'session.item.modelMode': '模型',
  'session.item.worktree': '工作树',
  'session.item.pending': '待处理',
  'session.item.thinking': '思考中',
  'session.time.justNow': '刚刚',
  'session.time.minutesAgo': '{n} 分钟前',
  'session.time.hoursAgo': '{n} 小时前',
  'session.time.daysAgo': '{n} 天前',

  // Session header
  'session.title': '文件',
  'session.more': '更多操作',

  // Session actions
  'session.action.rename': '重命名',
  'session.action.archive': '归档',
  'session.action.delete': '删除',
  'session.action.copy': '复制',

  // Dialogs
  'dialog.rename.title': '重命名会话',
  'dialog.rename.placeholder': '会话名称',
  'dialog.rename.save': '保存',
  'dialog.rename.saving': '保存中…',
  'dialog.rename.error': '重命名失败，请重试。',

  'dialog.archive.title': '归档会话',
  'dialog.archive.description': '确定要归档 "{name}" 吗？这将断开活动会话。',
  'dialog.archive.confirm': '归档',
  'dialog.archive.confirming': '归档中…',

  'dialog.delete.title': '删除会话',
  'dialog.delete.description': '确定要删除 "{name}" 吗？此操作无法撤销。',
  'dialog.delete.confirm': '删除',
  'dialog.delete.confirming': '删除中…',
  'dialog.error.default': '操作失败，请重试。',

  // Common buttons
  'button.cancel': '取消',
  'button.save': '保存',
  'button.confirm': '确认',
  'button.close': '关闭',
  'button.dismiss': '忽略',
  'button.copy': '复制',

  // New session form
  'newSession.machine': '机器',
  'newSession.directory': '目录',
  'newSession.placeholder': '/path/to/project',
  'newSession.recent': '最近路径',
  'newSession.type': '会话类型',
  'newSession.type.simple': '简单',
  'newSession.type.simple.desc': '直接使用选定的目录',
  'newSession.type.worktree': '工作树',
  'newSession.type.worktree.desc': '在仓库旁创建新工作树',
  'newSession.type.worktree.placeholder': 'feature-x (默认 1228-xxxx)',
  'newSession.agent': '代理',
  'newSession.yolo': 'YOLO 模式',
  'newSession.yolo.title': '跳过审批和沙箱',
  'newSession.yolo.desc': '启动时使用危险的代理标志。',
  'newSession.create': '创建',
  'newSession.creating': '创建中…',

  // Spawn session (old component)
  'spawn.title': '创建会话',
  'spawn.sessionType': '会话类型',
  'spawn.useAsIs': '直接使用选定的目录',
  'spawn.createWorktree': '在仓库旁创建新工作树',
  'spawn.worktreePlaceholder': 'feature-x (默认 1228-xxxx)',
  'spawn.cancel': '取消',
  'spawn.create': '创建会话',
  'spawn.creating': '创建中…',

  // Machine
  'machine.unknown': '未知平台',

  // Chat
  'chat.placeholder': '输入消息…',
  'chat.send': '发送',
  'chat.abort': '中止',
  'chat.settings': '设置',
  'chat.terminal': '终端',
  'chat.switchRemote': '切换到远程模式',

  // Terminal
  'terminal.commandName': '命令',
  'terminal.commandMessage': '命令消息',
  'terminal.commandArgs': '命令参数',
  'terminal.stdout': '标准输出',
  'terminal.stderr': '标准错误',

  // Code block
  'code.copy': '复制',

  // Diff view
  'diff.title': '差异',
  'diff.view': '查看',

  // Tool card
  'tool.askQuestion': '其他',
  'tool.edit': '编辑',
  'tool.multiedit': '多文件编辑',
  'tool.write': '写入',
  'tool.todo': '任务',
  'tool.confirm': '确认',
  'tool.deny': '拒绝',
  'tool.abort': '中止',
  'tool.allow': '允许',
  'tool.allowAll': '允许所有编辑',
  'tool.denyAll': '拒绝所有编辑',
  'tool.approved': '已批准',
  'tool.rejected': '已拒绝',
  'tool.cancel': '取消',
  'tool.exitPlan': '退出计划模式',
  'tool.patch': '补丁',
  'tool.input': '输入',
  'tool.result': '结果',
  'tool.questionsAnswers': '问答',
  'tool.submit': '提交',
  'tool.submitting': '提交中…',
  'tool.prev': '← 上一个',
  'tool.next': '下一个 →',
  'tool.yes': '是',
  'tool.yesForSession': '本会话允许',
  'tool.allowForSession': '本会话允许',
  'tool.abortLabel': '中止',
  'tool.other': '其他',
  'tool.otherDescription': '输入您自己的答案',
  'tool.question': '问题',
  'tool.selectOption': '请至少选择一个选项或输入答案。',
  'tool.waitingForApproval': '等待审批…',
  'tool.canceled': '已取消',
  'tool.approvedForSession': '本会话已批准',
  'tool.aborted': '已中止',
  'tool.approvedAllowAllEdits': '已批准：允许所有编辑',
  'tool.requestFailed': '请求失败',
  'tool.askUserQuestion.fallback': 'AskUserQuestion 格式不正确。请输入您的答案：',
  'tool.askUserQuestion.placeholder': '输入您的答案…',
  'tool.askUserQuestion.otherPlaceholder': '或输入您自己的答案…',

  // Composer buttons
  'composer.settings': '设置',
  'composer.terminal': '终端',
  'composer.abort': '中止',
  'composer.switchRemote': '切换到远程模式',
  'composer.send': '发送',

  // Banners
  'offline.title': '离线',
  'offline.message': '您当前处于离线状态。某些功能可能受限。',
  'syncing.title': '同步中…',
  'syncing.message': '正在同步您的数据。',

  // Install prompt
  'install.title': '安装 HAPI',
  'install.description': '将 HAPI 添加到主屏幕以便快速访问。',
  'install.button': '安装',

  // Language switcher
  'language.title': '语言',
  'language.english': 'English',
  'language.chinese': '简体中文',

  // Misc
  'misc.noMachines': '无可用机器',
  'misc.machine': '机器',
  'misc.permissionMode': '权限模式',
  'misc.model': '模型',
  'misc.loading': '加载中…',
  'misc.loadOlder': '加载更早的',
  'misc.newMessage': '{n} 条新消息',
  'misc.loadingMessages': '加载消息中…',
  'misc.typeMessage': "输入 'continue' 继续...",
  'misc.typeAMessage': '输入消息...',
  'misc.offline': '离线',
  'misc.permissionRequired': '需要权限',
  'misc.percentLeft': '剩余 {percent}%',
  'misc.online': '在线',
} as const
