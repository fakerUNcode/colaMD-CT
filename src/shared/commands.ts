// ColaMD CT：编辑器命令注册表。
//
// 主进程的「格式」菜单、渲染端的 DOM 快捷键、偏好设置里的改绑列表，三处认的
// 都是这一份表——快捷键改一处，菜单和键盘同时跟着变，不会各说各话。
//
// 默认键位对齐 Typora，但凡是和 ColaMD 既有绑定撞车的（Ctrl+T 新标签页、
// Ctrl+0 字号重置、Ctrl+Shift+7/8 列表……），一律让位既有绑定：CT 的原则是
// 「原软件的手感不变，往上加东西」。

export type CommandGroup = 'inline' | 'heading' | 'list' | 'block' | 'insert'

export interface EditorCommandSpec {
  /** 命令 id，与 format-commands.ts 的 FormatCommandId 一致。 */
  id: string
  zh: string
  en: string
  /** Electron accelerator；空串 = 默认无快捷键（仍可在偏好设置里绑）。 */
  accelerator: string
  group: CommandGroup
}

export const EDITOR_COMMANDS: readonly EditorCommandSpec[] = [
  // --- 行内标记 ---
  { id: 'bold', zh: '加粗', en: 'Bold', accelerator: 'CmdOrCtrl+B', group: 'inline' },
  { id: 'italic', zh: '斜体', en: 'Italic', accelerator: 'CmdOrCtrl+I', group: 'inline' },
  { id: 'underline', zh: '下划线', en: 'Underline', accelerator: 'CmdOrCtrl+U', group: 'inline' },
  { id: 'inlineCode', zh: '行内代码', en: 'Inline Code', accelerator: 'CmdOrCtrl+E', group: 'inline' },
  { id: 'strikethrough', zh: '删除线', en: 'Strikethrough', accelerator: 'CmdOrCtrl+Shift+X', group: 'inline' },
  { id: 'highlight', zh: '高亮', en: 'Highlight', accelerator: 'CmdOrCtrl+Shift+H', group: 'inline' },
  { id: 'mathInline', zh: '行内公式', en: 'Inline Math', accelerator: 'CmdOrCtrl+Shift+J', group: 'inline' },
  // 键位写物理键：美式键盘上 Shift+6 就是 `^`、Shift+` 就是 `~`（Typora 的
  // Ctrl+Shift+^ / Ctrl+Shift+~）。改绑捕获存的也是物理键形式，三层（改绑列表、
  // DOM 匹配、原生菜单）才对得上同一个键。
  { id: 'superscript', zh: '上标', en: 'Superscript', accelerator: 'CmdOrCtrl+Shift+6', group: 'inline' },
  { id: 'subscript', zh: '下标', en: 'Subscript', accelerator: 'CmdOrCtrl+Shift+`', group: 'inline' },
  { id: 'link', zh: '链接（网址取自剪贴板）', en: 'Link (URL from clipboard)', accelerator: 'CmdOrCtrl+K', group: 'inline' },
  // --- 标题 ---
  { id: 'heading1', zh: '一级标题', en: 'Heading 1', accelerator: 'CmdOrCtrl+1', group: 'heading' },
  { id: 'heading2', zh: '二级标题', en: 'Heading 2', accelerator: 'CmdOrCtrl+2', group: 'heading' },
  { id: 'heading3', zh: '三级标题', en: 'Heading 3', accelerator: 'CmdOrCtrl+3', group: 'heading' },
  { id: 'heading4', zh: '四级标题', en: 'Heading 4', accelerator: 'CmdOrCtrl+4', group: 'heading' },
  { id: 'heading5', zh: '五级标题', en: 'Heading 5', accelerator: 'CmdOrCtrl+5', group: 'heading' },
  { id: 'heading6', zh: '六级标题', en: 'Heading 6', accelerator: 'CmdOrCtrl+6', group: 'heading' },
  { id: 'paragraph', zh: '正文', en: 'Body Text', accelerator: 'CmdOrCtrl+Shift+0', group: 'heading' },
  { id: 'promoteHeading', zh: '提升标题级别', en: 'Promote Heading', accelerator: 'Alt+=', group: 'heading' },
  { id: 'demoteHeading', zh: '降低标题级别', en: 'Demote Heading', accelerator: 'Alt+-', group: 'heading' },
  // --- 列表 ---
  { id: 'bulletList', zh: '无序列表', en: 'Bullet List', accelerator: 'CmdOrCtrl+Shift+8', group: 'list' },
  { id: 'orderedList', zh: '有序列表', en: 'Ordered List', accelerator: 'CmdOrCtrl+Shift+7', group: 'list' },
  { id: 'taskList', zh: '任务列表', en: 'Task List', accelerator: 'CmdOrCtrl+Shift+9', group: 'list' },
  // --- 块级 ---
  { id: 'quote', zh: '引用', en: 'Blockquote', accelerator: 'CmdOrCtrl+Shift+Q', group: 'block' },
  { id: 'codeBlock', zh: '代码块', en: 'Code Block', accelerator: 'CmdOrCtrl+Shift+K', group: 'block' },
  { id: 'mathBlock', zh: '公式块', en: 'Math Block', accelerator: 'CmdOrCtrl+Shift+M', group: 'block' },
  // --- 插入 ---
  { id: 'image', zh: '插入图片…', en: 'Insert Image…', accelerator: 'CmdOrCtrl+Shift+I', group: 'insert' },
  { id: 'table', zh: '插入表格…', en: 'Insert Table…', accelerator: 'CmdOrCtrl+Shift+T', group: 'insert' },
  { id: 'hr', zh: '水平分割线', en: 'Horizontal Rule', accelerator: 'CmdOrCtrl+Shift+-', group: 'insert' },
  // 脚注：Typora 没有默认键，借 Word 的「插入脚注」Ctrl+Alt+F
  { id: 'footnote', zh: '脚注', en: 'Footnote', accelerator: 'CmdOrCtrl+Alt+F', group: 'insert' },
]

const BY_ID = new Map(EDITOR_COMMANDS.map((command) => [command.id, command]))

export function commandById(id: string): EditorCommandSpec | undefined {
  return BY_ID.get(id)
}

/**
 * 把用户覆盖表合到默认键位上，得到「命令 id → 生效 accelerator」。
 *
 * 覆盖值是空串表示解绑；值不是合法 accelerator（含空格、是未知命令）就忽略，
 * 宁可退回默认值，也不让一个手改坏的 settings.json 把菜单搭歪。
 */
export function mergeAccelerators(overrides: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const command of EDITOR_COMMANDS) merged[command.id] = command.accelerator
  if (!overrides || typeof overrides !== 'object') return merged
  for (const [id, value] of Object.entries(overrides)) {
    if (!BY_ID.has(id) || typeof value !== 'string') continue
    if (value !== '' && !isValidAccelerator(value)) continue
    merged[id] = value
  }
  return merged
}

/** 粗校验：非空、无空格、带一个修饰键或功能键。够拦住手改坏的情况。 */
export function isValidAccelerator(accelerator: string): boolean {
  if (!accelerator || accelerator.includes(' ')) return false
  return /(?:Ctrl|CmdOrCtrl|Command|Cmd|Alt|Option|AltGr|Shift|Meta|Super)\+/i.test(accelerator)
    || /^(?:F\d{1,2}|Escape|Tab)$/.test(accelerator)
}

/**
 * accelerator 的规范化形式，用来做相等比较（菜单读配置、DOM 键盘事件各自拼出
 * 字符串之后对一下这个形式，就等于在对「同一个键」）。
 *
 * CmdOrCtrl/Cmd/Command/Ctrl → ctrl；KeyIn→KeyIn；字符转成小写；+ 号统一。
 * 修饰键与键之间才切分（`Ctrl++` 的最后那个 + 是加号键本身，不是分隔符）。
 */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split(/\+(?=.)/).map((part) => part.trim()).filter(Boolean)
  const mods = new Set<string>()
  let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'cmdorctrl' || lower === 'ctrl' || lower === 'command' || lower === 'cmd') mods.add('ctrl')
    else if (lower === 'alt' || lower === 'option' || lower === 'altgr') mods.add('alt')
    else if (lower === 'shift') mods.add('shift')
    else if (lower === 'meta' || lower === 'super') mods.add('meta')
    else if (!key) key = lower
  }
  return [...mods].sort().join('+') + (key ? (mods.size ? '+' : '') + key : '')
}

/**
 * 符号键 → 物理键（美式键盘）。改绑捕获存的本来就是物理键形式；但手写进
 * settings.json 的加速键可能是按字符写的（`Ctrl+Shift+^`、`Ctrl+Shift+Backquote`），
 * 归一到物理键之后才和键盘事件的规范形式对得上。
 */
export const PHYSICAL_KEY: Record<string, string> = {
  '+': '=', plus: '=', '~': '`', backquote: '`',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', minus: '-', equal: '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'",
  '<': ',', '>': '.', '?': '/', space: 'space',
}

/**
 * accelerator → 按键匹配用的规范形式（修饰键归一 + 键归一到物理键）。
 * 改绑捕获存下来的、手写进 settings.json 的、键盘事件折出来的，三方都归到这一个形式再比。
 */
export function canonicalKey(accelerator: string): string {
  const parts = normalizeAccelerator(accelerator).split('+')
  const key = parts.pop() ?? ''
  return [...parts, PHYSICAL_KEY[key] ?? key].join('+')
}

const MODIFIER_ORDER = [ 'Ctrl', 'Cmd', 'Alt', 'Shift', 'Meta' ]

/**
 * accelerator 写给人看的形式。偏好设置的改绑列表、标题栏模块菜单、冲突提示共用它，
 * 三处看到的永远是同一个写法（2026-11-24 用户报「设置内快捷键和菜单栏不同步」：
 * 设置页写 `CmdOrCtrl+B`、菜单写 `Ctrl+B`，同一组键看着像两组）。
 *
 * Windows / Linux 上 CmdOrCtrl 写作 Ctrl，macOS 写作 Cmd；修饰键顺序固定为
 * Ctrl、Alt、Shift（手写的 `Shift+Alt+C` 也显示成 `Alt+Shift+C`）。
 */
export function displayAccelerator(accelerator: string, darwin = false): string {
  const ctrl = darwin ? 'Cmd' : 'Ctrl'
  const parts = accelerator.split(/\+(?=.)/).map((part) => part.trim()).filter(Boolean)
  const mods: string[] = []
  let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase()
    const mod = lower === 'cmdorctrl' || lower === 'ctrl' || lower === 'command' || lower === 'cmd' ? ctrl
      : lower === 'alt' || lower === 'option' || lower === 'altgr' ? 'Alt'
      : lower === 'shift' ? 'Shift'
      : lower === 'meta' || lower === 'super' ? 'Meta'
      : null
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod)
    } else if (!key) key = /^[a-z]$/i.test(part) ? part.toUpperCase() : part
  }
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return [...mods, key].filter(Boolean).join('+')
}

/** 按键事件里按键层的接口（KeyboardEvent 的一个子集，验收脚本里也能拼出来）。 */
export interface KeyLike {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  code: string
  key: string
}

/**
 * 键盘事件的物理键名：优先 event.code（布局无关），认不出再退 event.key。
 * 返回的是**物理键**（`6`、`` ` ``、`-`），不是打出来的字符（`^`、`~`、`_`）。
 */
export function physicalKeyOf(event: KeyLike): string | null {
  const code = event.code
  if (!code) return event.key.length === 1 ? event.key.toLowerCase() : null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  const named: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backquote: '`',
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
    Space: 'space',
  }
  if (code in named) return named[code]
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase()
  return event.key.length === 1 ? event.key.toLowerCase() : null
}

/**
 * 一次按键 → accelerator（物理键形式，`CmdOrCtrl+Shift+6`），改绑捕获用。
 * 没有 Ctrl/Cmd 或 Alt 修饰、或者认不出键位时返回 null。
 *
 * 修饰键必须拼进去（2026-11-24 实测：v2.7.22 归一物理键时把这一步改丢了，
 * 捕获函数只返回键名，于是按任何组合都被判成「需含 Ctrl/Cmd 或 Alt 修饰」，
 * 偏好设置里的改绑整条路是坏的）。
 */
export function acceleratorFromEvent(event: KeyLike): string | null {
  const hasCtrl = event.ctrlKey || event.metaKey
  const hasAlt = event.altKey
  if (!hasCtrl && !hasAlt) return null
  const key = physicalKeyOf(event)
  if (!key) return null
  const mods: string[] = []
  if (hasCtrl) mods.push('CmdOrCtrl')
  if (hasAlt) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return [...mods, /^[a-z]$/.test(key) ? key.toUpperCase() : key].join('+')
}
