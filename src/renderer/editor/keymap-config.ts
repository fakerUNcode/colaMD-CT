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

import { acceleratorFromEvent, canonicalKey, displayAccelerator, mergeAccelerators } from '../../shared/commands'
import { getEditorView } from './editor'
import { runFormatCommand, type FormatCommandId } from './format-commands'

/** 规范化 accelerator → 命令 id。 */
let bindings = new Map<string, FormatCommandId>()
/** 当前生效的「命令 id → accelerator」（默认 + 用户改绑；空串 = 解绑）。菜单提示从这里取。 */
let accelerators: Record<string, string> = mergeAccelerators(undefined)
let installed = false

export function applyKeybindings(merged: Record<string, string>): void {
  const next = new Map<string, FormatCommandId>()
  accelerators = merged
  for (const [id, accelerator] of Object.entries(merged)) {
    if (!accelerator) continue // 空串 = 用户解绑
    const normalized = canonicalKey(accelerator)
    if (normalized.split('+').length < 2) continue // 没有修饰键的不进这张表（不拦裸键）
    next.set(normalized, id as FormatCommandId)
  }
  bindings = next
}

/** 某条命令此刻的键，写成给人看的形式；没绑返回 undefined。标题栏模块菜单的提示用它。 */
export function commandKeyLabel(id: string): string | undefined {
  const accelerator = accelerators[id]
  return accelerator ? displayAccelerator(accelerator) : undefined
}

/** 把一个键盘事件折成与 canonicalKey 同构的规范形式。 */
function canonicalOf(event: KeyboardEvent): string | null {
  const accelerator = acceleratorFromEvent(event)
  return accelerator ? canonicalKey(accelerator) : null
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
