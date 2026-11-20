// ColaMD CT：快捷键的渲染端那一半。
//
// 键位的「真相」在 src/shared/commands.ts + settings.json：主进程用同一份
// 数据搭菜单 accelerator，这里把同一份数据变成 document 级的 keydown 匹配。
// 两边不会双触发——和 ⌘F/⌘/ 的既有做法同一条规矩：DOM 这一层 preventDefault
// 之后，菜单的同名快捷键不再触发。
//
// 为什么不用 CodeMirror 的 keymap：快捷键必须在焦点落在页面任何地方时都管用
// （文件面板、大纲都算），CM keymap 只在编辑器聚焦时生效；而改绑后要热更新，
// 一个 document 监听器换一张查找表比 compartment 重配扩展简单得多。

import { mergeAccelerators, normalizeAccelerator } from '../../shared/commands'
import { getEditorView } from './editor'
import { runFormatCommand, type FormatCommandId } from './format-commands'

/** 规范化 accelerator → 命令 id。 */
let bindings = new Map<string, FormatCommandId>()
let installed = false

/** accelerator 的键位部分先归一到物理键：`+` 在键盘上就是 `=`（Shift+=）。 */
function normalizeForLookup(accelerator: string): string {
  const normalized = normalizeAccelerator(accelerator)
  const parts = normalized.split('+')
  const key = parts.pop() ?? ''
  const mapped = key === '+' || key === 'plus' ? '=' : key
  return [...parts, mapped].join('+')
}

export function applyKeybindings(accelerators: Record<string, string>): void {
  const next = new Map<string, FormatCommandId>()
  for (const [id, accelerator] of Object.entries(accelerators)) {
    if (!accelerator) continue // 空串 = 用户解绑
    const normalized = normalizeForLookup(accelerator)
    if (normalized.split('+').length < 2) continue // 没有修饰键的不进这张表（不拦裸键）
    next.set(normalized, id as FormatCommandId)
  }
  bindings = next
}

/** 把一个键盘事件折成与 normalizeAccelerator 同构的规范形式。 */
function canonicalOf(event: KeyboardEvent): string | null {
  const hasCtrl = event.ctrlKey || event.metaKey
  const hasAlt = event.altKey
  if (!hasCtrl && !hasAlt) return null
  const key = physicalKeyOf(event)
  if (!key) return null
  // 纯 Alt+字母/数字不拦：那是 Windows 菜单访问键 / macOS 特殊字符的地盘；
  // Alt+符号（如 Alt+= 标题升降级）放行
  if (!hasCtrl && hasAlt && /^[a-z0-9]$/.test(key)) return null
  const mods: string[] = []
  if (hasCtrl) mods.push('ctrl')
  if (hasAlt) mods.push('alt')
  if (event.shiftKey) mods.push('shift')
  return [...mods].sort().join('+') + '+' + key
}

/** 物理键名：优先 event.code（布局无关），认不出再退 event.key。 */
function physicalKeyOf(event: KeyboardEvent): string | null {
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

/** 输入类控件里的按键不触发命令（搜索框、偏好设置的输入框、改绑捕获键、
 * 表格的单元格编辑——格子自己管 Tab/Enter）。 */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.colamd-pref-key-binding')) return true
  if (target.closest('.cm-md-table-widget')) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable && !target.closest('.cm-content')) return true
  return false
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || inTextField(event.target)) return
  const canonical = canonicalOf(event)
  if (!canonical) return
  const command = bindings.get(canonical)
  if (!command) return
  const view = getEditorView()
  if (!view) return
  event.preventDefault()
  event.stopPropagation()
  // 菜单路径触发时编辑器可能没焦点，键盘路径同样补一手
  if (!view.hasFocus) view.focus()
  runFormatCommand(view, command)
}

/** 初始化：拉设置、建表、挂监听（幂等）。 */
export async function initCommandKeymap(): Promise<void> {
  try {
    const settings = await window.electronAPI?.getSettings()
    applyKeybindings(mergeAccelerators(settings?.keybindings))
  } catch {
    applyKeybindings(mergeAccelerators(undefined))
  }
  if (!installed) {
    installed = true
    document.addEventListener('keydown', onKeyDown, true)
  }
}
