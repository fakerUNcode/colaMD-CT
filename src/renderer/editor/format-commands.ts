// 文本层面的格式命令：加粗、斜体、行内代码、删除线、链接、列表。
//
// 这里是「文本优先」架构最能体现差别的地方。旧实现在操作文档树里的 mark：
// 给一段文字加上 bold 标记，至于文件里该写 `**` 还是 `__`，由序列化器事后决定。
// 新实现直接在缓冲区里改字符：加粗就是在这段文字两端插入 `**`。
//
// 好处是可预测、可撤销，而且**只动用户选中的那段字节**，其余部分不受影响。
//
// ColaMD CT：命令集扩到 Typora 的全家桶（标题 1-6、引用、代码块、公式块、
// 高亮、任务列表、下划线、分割线、图片、表格），全部走同一个入口
// runFormatCommand，由菜单（editor:format）和 DOM 快捷键（keymap-config.ts）
// 两条路触发。块级插入遵循同一条规矩：先保证它是独立块（前后该补空行就补），
// 再落光标到该接着打字的位置。

import type { EditorView } from '@codemirror/view'
import { insertPickedImages } from './image-input'
import { openTablePicker } from './table-ops'

export type FormatCommandId =
  // 行内
  | 'bold'
  | 'italic'
  | 'underline'
  | 'inlineCode'
  | 'strikethrough'
  | 'highlight'
  | 'mathInline'
  | 'link'
  // 标题
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'paragraph'
  | 'promoteHeading'
  | 'demoteHeading'
  // 列表
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  // 块级
  | 'quote'
  | 'codeBlock'
  | 'mathBlock'
  // 插入
  | 'image'
  | 'table'
  | 'hr'

interface MarkerSpec {
  /** 包裹式标记：起止可以不同（下划线是 <u>…</u>）。 */
  open: string
  close: string
}

const WRAP_COMMANDS: Record<string, MarkerSpec> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  underline: { open: '<u>', close: '</u>' },
  inlineCode: { open: '`', close: '`' },
  strikethrough: { open: '~~', close: '~~' },
  highlight: { open: '==', close: '==' },
  mathInline: { open: '$', close: '$' },
}

/** 选区是否已经被这对标记包裹（含标记自身被选中一半的情况）。 */
function isWrapped(view: EditorView, from: number, to: number, open: string, close: string): boolean {
  const text = view.state.doc.toString()
  const before = text.slice(Math.max(0, from - open.length), from)
  const after = text.slice(to, to + close.length)
  return before === open && after === close
}

/** 在选区两端加上标记；已加则移除（toggle）。 */
function toggleWrap(view: EditorView, spec: MarkerSpec): void {
  const { from, to } = view.state.selection.main
  if (from === to) return

  if (isWrapped(view, from, to, spec.open, spec.close)) {
    // 移除两端标记
    view.dispatch({
      changes: [
        { from: from - spec.open.length, to: from, insert: '' },
        { from: to, to: to + spec.close.length, insert: '' },
      ],
      selection: { anchor: from - spec.open.length, head: to - spec.open.length },
    })
    return
  }

  // 选区内侧若已有标记（用户把标记也选进来了），先剥掉再统一加，避免叠成 `****`
  const text = view.state.doc.sliceString(from, to)
  const trimmed = text.startsWith(spec.open) && text.endsWith(spec.close) && text.length > spec.open.length + spec.close.length
    ? text.slice(spec.open.length, text.length - spec.close.length)
    : text

  view.dispatch({
    changes: { from, to, insert: `${spec.open}${trimmed}${spec.close}` },
    selection: { anchor: from + spec.open.length, head: from + spec.open.length + trimmed.length },
  })
  view.focus()
}

/** 取选区覆盖的整行范围。 */
function selectedLines(view: EditorView): { from: number; to: number; lines: string[] } {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)
  const lines: string[] = []
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(view.state.doc.line(n).text)
  }
  return { from: startLine.from, to: endLine.to, lines }
}

/** 在选中行的行首加/去列表前缀（toggle）。 */
function toggleList(view: EditorView, ordered: boolean): void {
  const { from, to, lines } = selectedLines(view)
  // 已经是同类列表就整体去掉，否则换成目标列表
  const bulletRe = /^(\s*)([-*+])\s+/
  const orderedRe = /^(\s*)(\d+)\.\s+/
  const isSameKind = lines.every((l) => (ordered ? orderedRe.test(l) : bulletRe.test(l)))
  const next = lines
    .map((line, i) => {
      if (isSameKind) return line.replace(ordered ? orderedRe : bulletRe, '$1')
      const stripped = line.replace(bulletRe, '$1').replace(orderedRe, '$1')
      return ordered ? stripped.replace(/^(\s*)/, `$1${i + 1}. `) : stripped.replace(/^(\s*)/, `$1- `)
    })
    .join('\n')

  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
  view.focus()
}

const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+/

/** 任务列表：整段已是任务列表则退回普通段落，否则把（列表）行换成 `- [ ] ` 任务。 */
function toggleTaskList(view: EditorView): void {
  const { from, to, lines } = selectedLines(view)
  const bulletRe = /^(\s*)([-*+]|\d+[.)])\s+/
  const allTasks = lines.every((l) => TASK_RE.test(l))
  const next = lines
    .map((line) => {
      if (allTasks) return line.replace(TASK_RE, '$1')
      const stripped = line.replace(TASK_RE, '$1').replace(bulletRe, '$1')
      return stripped.replace(/^(\s*)/, '$1- [ ] ')
    })
    .join('\n')
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
  view.focus()
}

// ─── 标题 ─────────────────────────────────────────────────────────────────────

const ATX_RE = /^(\s*)(#{1,6})(\s+|$)/

function setHeadingLevel(view: EditorView, level: number): void {
  const { from, to, lines } = selectedLines(view)
  const isSameLevel = lines.every((l) => {
    const match = ATX_RE.exec(l)
    return match ? match[2].length === level : false
  })
  const next = lines
    .map((line) => {
      const stripped = line.replace(ATX_RE, '$1')
      // toggle：再按一次同级标题 = 回正文
      return isSameLevel || level === 0 ? stripped : stripped.replace(/^(\s*)/, `$1${'#'.repeat(level)} `)
    })
    .join('\n')
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
  view.focus()
}

function stepHeading(view: EditorView, direction: 1 | -1): void {
  const { from, to, lines } = selectedLines(view)
  const next = lines
    .map((line) => {
      const match = ATX_RE.exec(line)
      if (match) {
        const level = Math.min(6, Math.max(1, match[2].length + direction))
        return line.replace(ATX_RE, `$1${'#'.repeat(level)} `)
      }
      // 正文行：提升从六级起步（离正文最近），降级从一级起步
      return line.replace(/^(\s*)/, `$1${direction === 1 ? '# ' : '###### '}`)
    })
    .join('\n')
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
  view.focus()
}

// ─── 块级插入 ─────────────────────────────────────────────────────────────────

/**
 * 块级片段的落点：fence/表格/hr 必须是独立块，插进行内会被段落吃掉。
 * 光标在空行上就就地插；在文字行上就挪到行后另起。
 */
function blockInsert(view: EditorView): { at: number; prefix: string } {
  const cursor = view.state.selection.main.to
  const line = view.state.doc.lineAt(cursor)
  const prev = line.number > 1 ? view.state.doc.line(line.number - 1) : null
  if (line.text.trim() !== '') return { at: line.to, prefix: '\n\n' }
  if (prev && prev.text.trim() !== '') return { at: line.from, prefix: '\n' }
  return { at: line.from, prefix: '' }
}

/** 用选中文本做围栏块（代码块/公式块）的内容；没选中就留空行，光标落进去。 */
function insertFenced(view: EditorView, fence: string): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.doc.sliceString(from, to)
  const inner = selected || ''
  const text = `${fence}\n${inner}\n${fence}`
  const { at, prefix } = blockInsert(view)
  const cursorAt = at + prefix.length + fence.length + 1
  view.dispatch({
    changes: { from: at, to: at, insert: prefix + text + '\n' },
    selection: { anchor: cursorAt },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
}

function insertHr(view: EditorView): void {
  const { at, prefix } = blockInsert(view)
  const text = `${prefix}---\n`
  view.dispatch({
    changes: { from: at, to: at, insert: text },
    selection: { anchor: at + text.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
}

/** 给选区包一条链接。URL 由调用方从主进程剪贴板取到后传入。 */
export function wrapLink(view: EditorView, url: string): void {
  const { from, to } = view.state.selection.main
  if (from === to) return
  const text = view.state.doc.sliceString(from, to)
  view.dispatch({
    changes: { from, to, insert: `[${text}](${url})` },
    selection: { anchor: from + 1, head: from + 1 + text.length },
  })
  view.focus()
}

/** 选区是否已经是链接，是则返回其外沿区间，用于「再按一次取消」。 */
export function linkRangeAt(view: EditorView, from: number, to: number): { from: number; to: number } | null {
  const text = view.state.doc.toString()
  const re = /\[([^\]]*)\]\((\S+?)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (start <= from && end >= to) return { from: start, to: end }
    if (start > to) break
  }
  return null
}

/** 引用：整段已是引用就摘掉，否则加 `> `。 */
function toggleQuote(view: EditorView): void {
  const { from, to, lines } = selectedLines(view)
  const quoteRe = /^(\s*)>\s?/
  const allQuoted = lines.every((l) => quoteRe.test(l))
  const next = lines
    .map((line) => (allQuoted ? line.replace(quoteRe, '$1') : line.replace(/^(\s*)/, '$1> ')))
    .join('\n')
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
  view.focus()
}

/** 执行一条格式命令。 */
export function runFormatCommand(view: EditorView, id: FormatCommandId): void {
  if (!view.hasFocus) return
  const wrapSpec = WRAP_COMMANDS[id]
  if (wrapSpec) {
    toggleWrap(view, wrapSpec)
    return
  }
  if (id === 'bulletList') {
    toggleList(view, false)
    return
  }
  if (id === 'orderedList') {
    toggleList(view, true)
    return
  }
  if (id === 'taskList') {
    toggleTaskList(view)
    return
  }
  if (id === 'quote') {
    toggleQuote(view)
    return
  }
  if (id === 'codeBlock') {
    insertFenced(view, '```')
    return
  }
  if (id === 'mathBlock') {
    insertFenced(view, '$$')
    return
  }
  if (id === 'hr') {
    insertHr(view)
    return
  }
  const headingLevel = /^heading([1-6])$/.exec(id)
  if (headingLevel) {
    setHeadingLevel(view, Number(headingLevel[1]))
    return
  }
  if (id === 'paragraph') {
    setHeadingLevel(view, 0)
    return
  }
  if (id === 'promoteHeading') {
    stepHeading(view, -1)
    return
  }
  if (id === 'demoteHeading') {
    stepHeading(view, 1)
    return
  }
  if (id === 'image') {
    void window.electronAPI?.pickImageFiles().then((picked) => {
      if (picked && picked.length > 0) insertPickedImages(view, picked)
    })
    return
  }
  if (id === 'table') {
    openTablePicker(view)
    return
  }
  if (id === 'link') {
    const { from, to } = view.state.selection.main
    if (from === to) return
    // 已是链接则取消
    const existing = linkRangeAt(view, from, to)
    if (existing) {
      const raw = view.state.doc.sliceString(existing.from, existing.to)
      const m = /^\[([^\]]*)\]\((\S+?)\)$/.exec(raw)
      if (m) {
        view.dispatch({
          changes: { from: existing.from, to: existing.to, insert: m[1] },
          selection: { anchor: existing.from, head: existing.from + m[1].length },
        })
        view.focus()
        return
      }
    }
    void window.electronAPI?.readClipboardText().then((text) => {
      const url = text.trim()
      if (!/^https?:\/\/\S+$/i.test(url)) return
      wrapLink(view, url)
    })
  }
}
