// ColaMD CT：表格编辑。
//
// 官方版把表格「渲染成真表格、光标进去退源码」，但没有给源码任何编辑辅助：
// 加一行要手敲一整行竖线，列宽对不齐，Tab 会跳出表格。这里补齐 Typora 的三件事：
//
//   1. 结构化操作：右键菜单加删行列、对齐、移动、删表——内部把表格源码块解析成
//      网格、改完再序列化回去，一次事务可撤销，竖线与空白按列宽对齐（Typora 同款）。
//   2. 键盘流：Tab/Shift+Tab 在单元格间走，末格 Tab 追加行；Enter 到下一行，
//      末行 Enter 加行（避免裸回车把表格行拆断）；Shift+Enter 写 <br>。
//   3. 列宽拖拽：表头右缘的把手直接拖。宽度存 userData sidecar（按文档路径 +
//      表头内容做键），不往 md 文件里写一个多余的字节。
//
// 光标在表格里时整块退源码，所以这些操作全部作用在源码文本上，与「缓冲区即文件」
// 的纪律一致：表格怎么改，改的都是用户看得见的字。

import { keymap, type EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { Prec, type EditorState } from '@codemirror/state'

export type ColumnAlign = 'left' | 'center' | 'right' | 'default'

export interface TableModel {
  /** 含表头；rows[0] 是表头，其余是正文行。分隔行不在这里，对齐单独存。 */
  rows: string[][]
  aligns: ColumnAlign[]
}

// ─── 解析与序列化 ─────────────────────────────────────────────────────────────

/** 一行源码按未转义 `|` 拆单元格；`\|` 还原成字面量。与 live-preview 的 parseTable 同规矩。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
}

function alignOfDelimiter(cell: string): ColumnAlign {
  const trimmed = cell.trim()
  const left = trimmed.startsWith(':')
  const right = trimmed.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'default' // 裸 `---`：序列化时原样写回，不添冒号
}

/** 源码块 → 网格。不是合法表格（缺分隔行，或混进了不含管道符的普通文字行）
 * 返回 null。后者是防御：表格后不空一行时语法节点会把下一行吞进来，把它当
 * 表格行重写会改坏用户的正文，宁可拒绝操作。 */
export function parseTableModel(source: string): TableModel | null {
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) return null
  if (lines.some((line) => !line.includes('|'))) return null
  const header = splitRow(lines[0])
  const delimiter = splitRow(lines[1])
  if (!isDelimiterRow(delimiter)) return null
  const width = header.length
  const aligns: ColumnAlign[] = []
  for (let c = 0; c < width; c++) aligns.push(alignOfDelimiter(delimiter[c] ?? ''))
  const rows: string[][] = [header]
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i])
    // 多的截掉、少的补空：表头列数就是表格列数
    const row: string[] = []
    for (let c = 0; c < width; c++) row.push(cells[c] ?? '')
    rows.push(row)
  }
  return { rows, aligns }
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|')
}

/** 网格 → 源码块：竖线对齐，空行距随最宽单元格走。 */
export function serializeTableModel(model: TableModel): string {
  const width = model.aligns.length
  const escaped = model.rows.map((row) => row.map(escapeCell))
  const widths: number[] = []
  for (let c = 0; c < width; c++) {
    let longest = 3
    for (const row of escaped) longest = Math.max(longest, row[c].length)
    widths.push(longest)
  }
  const pad = (text: string, target: number, align: ColumnAlign): string => {
    const spaces = Math.max(0, target - text.length)
    if (align === 'center') {
      const left = Math.floor(spaces / 2)
      return ' '.repeat(left) + text + ' '.repeat(spaces - left)
    }
    if (align === 'right') return ' '.repeat(spaces) + text
    return text + ' '.repeat(spaces)
  }
  const delimiter = model.aligns.map((align, c) => {
    const marks = '-'.repeat(Math.max(3, widths[c]))
    if (align === 'center') return `:${marks}:`
    if (align === 'right') return `${marks}:`
    if (align === 'left') return `:${marks}`
    return marks
  })
  const lines: string[] = [
    `| ${escaped[0].map((cell, c) => pad(cell, widths[c], model.aligns[c])).join(' | ')} |`,
    `| ${delimiter.join(' | ')} |`,
  ]
  for (let r = 1; r < escaped.length; r++) {
    lines.push(`| ${escaped[r].map((cell, c) => pad(cell, widths[c], model.aligns[c])).join(' | ')} |`)
  }
  return lines.join('\n')
}

// ─── 定位：光标在哪个表格、哪一格 ────────────────────────────────────────────

export interface TableRange {
  from: number
  to: number
}

/** 光标所在处有没有被一个 Table 节点罩住（两端都算在内，与 isBlockActive 一致）。 */
export function tableRangeAt(state: EditorState, pos: number): TableRange | null {
  let found: TableRange | null = null
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found) return false
      if (node.name !== 'Table') return
      if (node.from <= pos && pos <= node.to) {
        found = { from: node.from, to: node.to }
        return false
      }
      // 只往可能包含 pos 的子树走，剪掉完全不相关的分支
      return node.from > pos || node.to < pos
    },
  })
  return found
}

export interface CellLocation {
  /** 渲染行号：0 = 表头，1..n = 正文行。 */
  row: number
  col: number
  rowCount: number
  colCount: number
}

/** 光标落在表格的哪一格。row 是渲染行号（0 = 表头），分隔行会折算到上一行。 */
export function cellAt(state: EditorState, range: TableRange, pos: number): CellLocation | null {
  const model = parseTableModel(state.doc.sliceString(range.from, range.to))
  if (!model) return null
  const firstLine = state.doc.lineAt(range.from)
  const line = state.doc.lineAt(pos)
  let row = line.number - firstLine.number
  if (row < 0 || row > model.rows.length) return null
  if (row >= 1) row -= 1 // 源码行 1 是分隔行
  if (row < 0) row = 0
  const colIndex = cellIndexOfOffset(line.text, pos - line.from)
  return {
    row: Math.min(row, model.rows.length - 1),
    col: Math.min(Math.max(0, colIndex), model.aligns.length - 1),
    rowCount: model.rows.length,
    colCount: model.aligns.length,
  }
}

/** 行内偏移落在第几个单元格里（未转义 `|` 计数；行首那根管道不算分隔）。 */
function cellIndexOfOffset(text: string, offset: number): number {
  let index = 0
  const limit = Math.min(offset, text.length)
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      i++
      continue
    }
    if (text[i] === '|') index++
  }
  // 行首管道符是「表格行的开场」，不是单元格分隔：count 多计了一根
  const startsWithPipe = /^\s*\|/.test(text.slice(0, limit + 1))
  return startsWithPipe ? Math.max(0, index - 1) : index
}

/** 新文本里第 row 行第 col 格的（块内）偏移，供操作后落光标。row 0 = 表头。 */
function cellOffsetInText(text: string, row: number, col: number): number {
  const lines = text.split('\n')
  // 源码行：0 = 表头，1 = 分隔行，2+ = 正文。渲染行 0 → 行 0；渲染行 r ≥ 1 → 行 r+1。
  const lineIndex = Math.min(row === 0 ? 0 : row + 1, lines.length - 1)
  const target = lines[lineIndex] ?? ''
  // 落点跳过管道符后面的那个空格，直接站在内容前（Typora 的手感）
  const afterPipe = (i: number): number => i + 1 + (target[i + 1] === ' ' ? 1 : 0)
  const starts: number[] = []
  const firstPipe = target.indexOf('|')
  if (firstPipe >= 0) starts.push(afterPipe(firstPipe))
  for (let i = firstPipe + 1; i < target.length; i++) {
    if (target[i] === '\\' && target[i + 1] === '|') {
      i++
      continue
    }
    if (target[i] === '|') starts.push(afterPipe(i))
  }
  const within = starts[Math.min(col, starts.length - 1)] ?? 0
  let before = 0
  for (let i = 0; i < lineIndex; i++) before += (lines[i]?.length ?? 0) + 1
  return before + within
}

// ─── 结构化操作 ───────────────────────────────────────────────────────────────

export type TableAction =
  | 'insertRowAbove' | 'insertRowBelow' | 'insertColLeft' | 'insertColRight'
  | 'deleteRow' | 'deleteCol' | 'moveRowUp' | 'moveRowDown' | 'moveColLeft' | 'moveColRight'
  | 'alignLeft' | 'alignCenter' | 'alignRight' | 'deleteTable'

/** 把 model 重写回文档。caretOutside=true（默认，右键菜单/渲染态提交）时光标落在
 * 表格外——表格保持渲染；false（源码态键盘流）时光标落进 (row, col) 格。 */
function applyModel(view: EditorView, range: TableRange, model: TableModel, cursorRow: number, cursorCol: number, caretOutside = true): boolean {
  const text = serializeTableModel(model)
  // 新文档长度要自己算：此刻 view.state 还是旧文档（表头表尾一改长度就变了），
  // 拿旧长度当上界会把「出块 +1」吞掉，光标停在表格末端（闭区间的 to 上），
  // isBlockActive 判成「块内」→ 表格退源码。
  const newLength = view.state.doc.length - (range.to - range.from) + text.length
  let cursorAt: number
  if (caretOutside) {
    // 落在表格结束之后（跨过换行才算「出块」：isBlockActive 是两端闭区间）
    cursorAt = range.from + text.length
    if (cursorAt < newLength) cursorAt++
  } else {
    cursorAt = range.from + cellOffsetInText(text, Math.max(0, Math.min(cursorRow, model.rows.length - 1)), Math.max(0, Math.min(cursorCol, model.aligns.length - 1)))
  }
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: cursorAt },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

export function runTableAction(
  view: EditorView,
  range: TableRange,
  location: CellLocation,
  action: TableAction,
  caretOutside = true,
): boolean {
  const model = parseTableModel(view.state.doc.sliceString(range.from, range.to))
  if (!model) return false
  const { row, col } = location
  const emptyRow = () => model.aligns.map(() => '')

  switch (action) {
    case 'insertRowAbove':
      model.rows.splice(row, 0, emptyRow())
      return applyModel(view, range, model, row, col, caretOutside)
    case 'insertRowBelow':
      model.rows.splice(row + 1, 0, emptyRow())
      return applyModel(view, range, model, row + 1, col, caretOutside)
    case 'insertColLeft':
      for (const tableRow of model.rows) tableRow.splice(col, 0, '')
      model.aligns.splice(col, 0, model.aligns[col] ?? 'left')
      return applyModel(view, range, model, row, col, caretOutside)
    case 'insertColRight':
      for (const tableRow of model.rows) tableRow.splice(col + 1, 0, '')
      model.aligns.splice(col + 1, 0, model.aligns[col] ?? 'left')
      return applyModel(view, range, model, row, col + 1, caretOutside)
    case 'deleteRow':
      if (model.rows.length <= 1) return false // 表头不许删光：那等于删表
      model.rows.splice(row, 1)
      return applyModel(view, range, model, Math.max(0, row - 1), col, caretOutside)
    case 'deleteCol':
      if (model.aligns.length <= 1) return false
      for (const tableRow of model.rows) tableRow.splice(col, 1)
      model.aligns.splice(col, 1)
      return applyModel(view, range, model, row, Math.min(col, model.aligns.length - 1), caretOutside)
    case 'moveRowUp':
      if (row <= 1) return false // 表头(0)不动；正文第一行没有「上」
      ;[model.rows[row - 1], model.rows[row]] = [model.rows[row], model.rows[row - 1]]
      return applyModel(view, range, model, row - 1, col, caretOutside)
    case 'moveRowDown':
      if (row >= model.rows.length - 1) return false
      ;[model.rows[row + 1], model.rows[row]] = [model.rows[row], model.rows[row + 1]]
      return applyModel(view, range, model, row + 1, col, caretOutside)
    case 'moveColLeft':
      if (col <= 0) return false
      for (const tableRow of model.rows) {
        ;[tableRow[col - 1], tableRow[col]] = [tableRow[col], tableRow[col - 1]]
      }
      ;[model.aligns[col - 1], model.aligns[col]] = [model.aligns[col], model.aligns[col - 1]]
      return applyModel(view, range, model, row, col - 1, caretOutside)
    case 'moveColRight':
      if (col >= model.aligns.length - 1) return false
      for (const tableRow of model.rows) {
        ;[tableRow[col + 1], tableRow[col]] = [tableRow[col], tableRow[col + 1]]
      }
      ;[model.aligns[col + 1], model.aligns[col]] = [model.aligns[col], model.aligns[col + 1]]
      return applyModel(view, range, model, row, col + 1, caretOutside)
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight': {
      const align: ColumnAlign = action === 'alignLeft' ? 'left' : action === 'alignCenter' ? 'center' : 'right'
      model.aligns[col] = align
      return applyModel(view, range, model, row, col, caretOutside)
    }
    case 'deleteTable': {
      // 连同表格后面的换行一起清掉，免得留下一个空行壳
      let to = range.to
      const doc = view.state.doc
      if (to < doc.length && doc.sliceString(to, to + 1) === '\n') to++
      view.dispatch({ changes: { from: range.from, to, insert: '' }, userEvent: 'delete.selection' })
      return true
    }
  }
}

/** 末行追加一行空行。源码态（光标已在源码里）光标落进新格，方便接着打字。 */
function appendRow(view: EditorView, range: TableRange, location: CellLocation): void {
  runTableAction(view, range, location, 'insertRowBelow', false)
}

// ─── 右键菜单 ─────────────────────────────────────────────────────────────────

/**
 * 原生菜单是模态的：右键到点菜之间文档不会变，但菜单动作经主进程绕一圈回来，
 * 这期间谁都不敢保证。所以只记目标（右键时的表格区间 + 行列），动作回来时
 * 重新解析验证，对不上就放弃。
 */
interface TableMenuTarget {
  range: TableRange
  location: CellLocation
}

let lastMenuTarget: TableMenuTarget | null = null

/** editor.ts 的 contextmenu 处理器调用：记下右键目标并请主进程弹菜单。 */
export function openTableContextMenu(range: TableRange, location: CellLocation): void {
  lastMenuTarget = { range, location }
  void window.electronAPI?.showTableContextMenu({
    canMoveRowUp: location.row > 1,
    canMoveRowDown: location.row < location.rowCount - 1,
    canMoveColLeft: location.col > 0,
    canMoveColRight: location.col < location.colCount - 1,
    canDeleteRow: location.rowCount > 1,
    canDeleteCol: location.colCount > 1,
  })
}

/** 主进程菜单动作回发后的执行入口（外壳 main.ts 接线）。 */
export function runTableMenuAction(view: EditorView, action: TableAction): boolean {
  const target = lastMenuTarget
  lastMenuTarget = null
  if (!target) return false
  // 重新按起点找表格并验证区间没变：菜单是模态的，通常原样命中；
  // 文档若真的变了（不该发生），宁可不动也别在错的地方下刀。
  const current = tableRangeAt(view.state, target.range.from)
  if (!current || current.from !== target.range.from || current.to !== target.range.to) return false
  if (!parseTableModel(view.state.doc.sliceString(current.from, current.to))) return false
  return runTableAction(view, current, target.location, action)
}

// ─── 键盘流：Tab / Shift+Tab / Enter / Shift+Enter ────────────────────────────

function moveToCell(view: EditorView, range: TableRange, row: number, col: number): void {
  const text = view.state.doc.sliceString(range.from, range.to)
  const pos = range.from + cellOffsetInText(text, row, col)
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
}

function tabInTable(view: EditorView, direction: 1 | -1): boolean {
  const pos = view.state.selection.main.to
  const range = tableRangeAt(view.state, pos)
  if (!range) return false
  const location = cellAt(view.state, range, pos)
  if (!location) return false
  let { row, col } = location
  col += direction
  if (col >= location.colCount) {
    if (row >= location.rowCount - 1) {
      appendRow(view, range, location) // 末格 Tab：Typora 的「顺手加一行」
      return true
    }
    row++
    col = 0
  } else if (col < 0) {
    if (row <= 0) return true // 表头第一格：留在原地，别把光标甩出表格
    row--
    col = location.colCount - 1
  }
  moveToCell(view, range, row, col)
  return true
}

function enterInTable(view: EditorView): boolean {
  const pos = view.state.selection.main.to
  const range = tableRangeAt(view.state, pos)
  if (!range) return false
  const location = cellAt(view.state, range, pos)
  if (!location) return false
  // Enter：下一行同列（末行则加行）。裸回车会把表格行拆成断行，那是最常见的误伤。
  if (location.row >= location.rowCount - 1) appendRow(view, range, location)
  else moveToCell(view, range, location.row + 1, location.col)
  return true
}

function softBreakInTable(view: EditorView): boolean {
  const pos = view.state.selection.main.to
  const range = tableRangeAt(view.state, pos)
  if (!range) return false
  // 格内换行 = <br>（GFM 表格行里放不下真换行）
  view.dispatch({ changes: { from: pos, insert: '<br>' }, selection: { anchor: pos + 4 }, userEvent: 'input' })
  return true
}

/** 装进编辑器的扩展。Prec.high：列表的 Tab 缩进在表格里必须让路。 */
export const tableInput = Prec.high(keymap.of([
  { key: 'Tab', run: (view) => tabInTable(view, 1) },
  { key: 'Shift-Tab', run: (view) => tabInTable(view, -1) },
  { key: 'Enter', run: (view) => enterInTable(view) },
  { key: 'Shift-Enter', run: (view) => softBreakInTable(view) },
]))

// ─── 渲染态单元格编辑（Typora 手感：点格子就地改，表格不退源码）──────────────
//
// 官方版「光标进表格 → 整块退源码」的判据是 isBlockActive；这里绕开它：点击格子
// 不再给 CodeMirror 落光标（editor.ts 的 mousedown 让路），而是把那个 <td> 变成
// contenteditable 就地编辑。缓冲区在编辑期间不动 → 装饰不重算 → 表格一直渲染。
// Tab/Enter 提交时把格子文本序列化回源码（一次可撤销事务，光标落在表外，
// 表格保持渲染），需要继续编辑下一格时用 pendingCellFocus 在重建后的 widget
// 上接着聚焦。真正的源码编辑还在：源码模式、或键盘把光标移进表格时走旧路。

interface CellEdit {
  view: EditorView
  table: HTMLTableElement
  from: number
  to: number
  row: number
  col: number
  td: HTMLTableCellElement
}

let cellEdit: CellEdit | null = null
/** 要接着聚焦的格子（Tab/Enter 重建后 / 点击新格子）。click 有值 = 按点击坐标摆光标。 */
let pendingCellFocus: { view: EditorView; row: number; col: number; click?: { x: number; y: number } } | null = null

function tableCellAt(table: HTMLTableElement, row: number, col: number): HTMLTableCellElement | null {
  const tr = table.querySelectorAll('tr')[row]
  const td = tr?.children[col]
  return td instanceof HTMLTableCellElement ? td : null
}

function focusCell(view: EditorView, table: HTMLTableElement, row: number, col: number, click?: { x: number; y: number }): void {
  const td = tableCellAt(table, row, col)
  if (!td) return
  cellEdit = {
    view,
    table,
    from: Number(table.dataset.sourceFrom),
    to: Number(table.dataset.sourceTo),
    row,
    col,
    td,
  }
  td.setAttribute('contenteditable', 'plaintext-only')
  td.classList.add('cm-md-cell-editing')
  if (!td.dataset.ctWired) {
    td.dataset.ctWired = '1'
    td.addEventListener('keydown', onCellKeydown)
    td.addEventListener('blur', onCellBlur)
  }
  td.focus()
  const sel = window.getSelection()
  if (click && document.caretRangeFromPoint) {
    const point = document.caretRangeFromPoint(click.x, click.y)
    if (point && td.contains(point.startContainer) && sel) {
      sel.removeAllRanges()
      sel.addRange(point)
      return
    }
  }
  // 默认光标放末尾（Tab/Enter 顺延的手感）
  const range = document.createRange()
  range.selectNodeContents(td)
  range.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function onCellBlur(this: HTMLTableCellElement): void {
  // 只有「正在编辑的这格」失焦才结算；Tab 换格时旧的 blur 晚于 cellEdit 切换，跳过
  if (cellEdit && cellEdit.td === this) commitCellEdit(null)
}

/**
 * 结算当前格子：文本有变化就把整张表序列化写回缓冲区（光标落在表外，表格
 * 保持渲染）。next 非空时聚焦下一格——有事务就等重建（pendingCellFocus），
 * 没事务直接在现有 DOM 上聚焦。
 */
export function commitCellEdit(next: { row: number; col: number } | null): void {
  const edit = cellEdit
  if (!edit) return
  cellEdit = null
  edit.td.removeAttribute('contenteditable')
  edit.td.classList.remove('cm-md-cell-editing')
  const text = (edit.td.textContent ?? '').trim()
  const model = parseTableModel(edit.view.state.doc.sliceString(edit.from, edit.to))
  if (model && model.rows[edit.row]) {
    if (model.rows[edit.row][edit.col] !== text) {
      model.rows[edit.row][edit.col] = text
      if (next) pendingCellFocus = { view: edit.view, row: next.row, col: next.col }
      applyModel(edit.view, { from: edit.from, to: edit.to }, model, edit.row, edit.col)
      return // 重建后的 toDOM → applyPendingCellFocus（下一帧）接手
    }
  }
  // 文本没变：不重建，直接在现有 DOM 上跳（此刻不在 CM 更新里，同步聚焦是安全的）
  if (next) focusCell(edit.view, edit.table, next.row, next.col)
}

/** TableWidget.toDOM 重建完调用：接住 Tab/Enter 链上的下一格焦点。
 *
 * toDOM 发生在 CodeMirror 的更新事务**内部**，此刻绝不能动焦点——td.focus()
 * 会触发 focus 事件，处理器里的 view.dispatch 重入未完成的更新，CodeMirror
 * 直接抛「update is in progress」，整个绘制作废、表格消失。所以只记下位置，
 * 等下一帧在**已挂载**的表上聚焦。 */
let pendingFocusScheduled = false
export function applyPendingCellFocus(table: HTMLTableElement): void {
  const pending = pendingCellFocus
  if (!pending) return
  pendingCellFocus = null
  const from = Number(table.dataset.sourceFrom)
  if (!Number.isFinite(from) || pendingFocusScheduled) return
  pendingFocusScheduled = true
  requestAnimationFrame(() => {
    pendingFocusScheduled = false
    const mounted = document.querySelector(`.cm-md-table-widget[data-source-from="${from}"]`)
    if (mounted instanceof HTMLTableElement && mounted.isConnected) {
      focusCell(pending.view, mounted, pending.row, pending.col, pending.click)
    }
  })
}

function onCellKeydown(this: HTMLTableCellElement, event: KeyboardEvent): void {
  const edit = cellEdit
  if (!edit || edit.td !== this) return
  const rowCount = edit.table.querySelectorAll('tr').length
  const colCount = edit.table.querySelectorAll('tr')[0]?.children.length ?? edit.col + 1

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    commitCellEdit(null)
    this.blur()
    return
  }
  if (event.key === 'Enter' && event.shiftKey) {
    // 格内换行写 <br>（GFM 表格行放不下真换行）
    event.preventDefault()
    event.stopPropagation()
    document.execCommand('insertText', false, '<br>')
    return
  }
  if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
    event.preventDefault()
    event.stopPropagation()
    const forward = event.key === 'Tab' && event.shiftKey ? -1 : 1
    if (forward === -1) {
      // Shift+Tab：上一格；表头第一格原地不动
      if (edit.col > 0) commitCellEdit({ row: edit.row, col: edit.col - 1 })
      else if (edit.row > 0) {
        const prevRowCols = edit.table.querySelectorAll('tr')[edit.row - 1]?.children.length ?? colCount
        commitCellEdit({ row: edit.row - 1, col: prevRowCols - 1 })
      }
      return
    }
    const nextCell =
      edit.col + 1 < colCount ? { row: edit.row, col: edit.col + 1 }
      : edit.row + 1 < rowCount ? { row: edit.row + 1, col: 0 }
      : null
    if (nextCell) {
      commitCellEdit(nextCell)
      return
    }
    // 末格 Tab/Enter：追加一行，焦点进新行同列（表格保持渲染）
    const appendCol = event.key === 'Enter' ? edit.col : 0
    commitCellEdit(null)
    const range = tableRangeAt(edit.view.state, edit.from)
    if (range) {
      pendingCellFocus = { view: edit.view, row: edit.row + 1, col: appendCol }
      runTableAction(edit.view, range, { row: edit.row, col: edit.col, rowCount, colCount }, 'insertRowBelow')
    }
  }
}

/**
 * editor.ts 的表格 mousedown 调用：点到的格子就地进入编辑。
 * 返回 'new' = 进入了新格子（调用方需 preventDefault，焦点由这里接管）；
 * 'same' = 点的正是编辑中的格子（**不要** preventDefault，浏览器原生光标
 *          放置正是我们要的——之前的 bug 就是无条件 preventDefault 把
 *          同格二次点击挡死了，光标永远停在下第一次的位置）；
 * false = 不是格子（比如拖列宽的把手），调用方走旧逻辑。
 */
export function beginCellEdit(view: EditorView, widget: HTMLElement, e: MouseEvent): 'new' | 'same' | false {
  const target = e.target as HTMLElement
  if (target.closest('.cm-md-col-resizer')) return false
  const rowEl = target.closest('tr')
  const cellEl = target.closest('th, td')
  if (!rowEl || !cellEl) return false
  const from = Number(widget.dataset.sourceFrom)
  const to = Number(widget.dataset.sourceTo)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false
  if (!parseTableModel(view.state.doc.sliceString(from, to))) return false
  const rowIndex = [...widget.querySelectorAll('tr')].indexOf(rowEl)
  const colIndex = [...rowEl.children].indexOf(cellEl)
  if (rowIndex < 0 || colIndex < 0) return false
  const table = widget as HTMLTableElement

  // 已在编辑这一格：交给浏览器按点击位置摆光标（原生行为，随点随动）
  if (cellEdit && cellEdit.td === cellEl) return 'same'

  // 先结算上一格：文本有变会触发重建，用 pending（含点击坐标）把焦点与光标
  // 接到本格的新 DOM 上；没变就在下一帧直接聚焦当前表
  pendingCellFocus = { view, row: rowIndex, col: colIndex, click: { x: e.clientX, y: e.clientY } }
  commitCellEdit(null)
  if (!cellEdit) applyPendingCellFocus(table)
  return 'new'
}

// ─── 插入表格（网格选择器）───────────────────────────────────────────────────

/** 生成 r 行（含表头）c 列的空表源码。 */
function tableSource(rows: number, cols: number): string {
  const model: TableModel = {
    rows: Array.from({ length: Math.max(2, rows) }, () => Array.from({ length: Math.max(1, cols) }, () => '')),
    aligns: Array.from({ length: Math.max(1, cols) }, () => 'default' as ColumnAlign),
  }
  return serializeTableModel(model)
}

/**
 * 在光标处插一张空表。表格必须是独立块：光标在段落中间时先起新块，
 * 前一行非空时补一个空行（否则表格行会被当成段落的续行吃掉）。
 */
export function insertTable(view: EditorView, rows: number, cols: number): void {
  const cursor = view.state.selection.main.to
  const line = view.state.doc.lineAt(cursor)
  const prev = line.number > 1 ? view.state.doc.line(line.number - 1) : null
  let prefix = ''
  if (line.text.trim() !== '') prefix = '\n\n'
  else if (prev && prev.text.trim() !== '') prefix = '\n'
  const text = prefix + tableSource(rows, cols) + '\n'
  const insertAt = line.to
  // 光标放进表头第一格
  const cursorAt = insertAt + prefix.length + 2
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert: text },
    selection: { anchor: cursorAt },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
}

let pickerEscHandler: ((event: KeyboardEvent) => void) | null = null

function closeTablePicker(): void {
  const existing = document.getElementById('colamd-table-picker')
  if (!existing) return
  if (pickerEscHandler) {
    document.removeEventListener('keydown', pickerEscHandler, true)
    pickerEscHandler = null
  }
  existing.remove()
}

/** Typora 式悬浮网格：拖选 行×列，点击落表。Esc / 点外面取消。 */
export function openTablePicker(view: EditorView): void {
  closeTablePicker()
  const zh = isChineseRenderer()
  const MAX_ROWS = 10
  const MAX_COLS = 8

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay colamd-table-picker-overlay'
  overlay.id = 'colamd-table-picker'
  const modal = document.createElement('div')
  modal.className = 'math-modal colamd-table-picker'
  const label = document.createElement('div')
  label.className = 'colamd-table-picker-label'
  label.textContent = zh ? '插入表格' : 'Insert table'
  const grid = document.createElement('div')
  grid.className = 'colamd-table-picker-grid'
  const cells: HTMLElement[] = []
  for (let r = 1; r <= MAX_ROWS; r++) {
    for (let c = 1; c <= MAX_COLS; c++) {
      const cell = document.createElement('div')
      cell.className = 'colamd-table-picker-cell'
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      cell.addEventListener('mouseenter', () => highlight(r, c))
      cell.addEventListener('click', () => {
        closeTablePicker()
        insertTable(view, r, c)
      })
      grid.appendChild(cell)
      cells.push(cell)
    }
  }
  const hint = document.createElement('div')
  hint.className = 'colamd-table-picker-hint'
  hint.textContent = zh ? '拖选行 × 列（第一行为表头）' : 'Drag over rows × cols (first row is the header)'

  function highlight(row: number, col: number): void {
    for (const cell of cells) {
      cell.classList.toggle('active', Number(cell.dataset.row) <= row && Number(cell.dataset.col) <= col)
    }
    label.textContent = zh ? `${row} 行 × ${col} 列` : `${row} × ${col}`
  }

  const close = (event?: MouseEvent): void => {
    if (event && event.target !== overlay) return
    closeTablePicker()
  }
  overlay.addEventListener('mousedown', close)
  pickerEscHandler = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeTablePicker()
  }
  document.addEventListener('keydown', pickerEscHandler, true)

  modal.append(label, grid, hint)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  highlight(2, 2)
}

function isChineseRenderer(): boolean {
  return navigator.language.toLowerCase().startsWith('zh')
}

// ─── 列宽拖拽（session + sidecar 持久化）─────────────────────────────────────

/** contentKey → 每列宽度百分比。整个会话共享（多窗口同文档取同一份）。 */
const sessionWidths = new Map<string, number[]>()
let widthsDirty = false
/** 宽度属于哪个文档。换文档前先按**旧**路径落盘，避免记到新文档头上。 */
let widthsDocPath: string | null = null
/** 偏好设置 → 表格 → 记住列宽。关掉后不再加载/套用/落盘 sidecar。 */
let rememberTableWidths = true

export function setRememberTableWidths(on: boolean): void {
  rememberTableWidths = on
  // 关掉即刻生效：现有存档从本会话撤下，重建后的表格回到等宽
  if (!on) sessionWidths.clear()
}

/** 表格的稳定键：表头行内容 + 列数。改单元格内容不丢列宽，改表头才会重置。 */
export function tableWidthKey(source: string): string {
  const firstLine = source.split('\n', 1)[0] ?? ''
  let hash = 5381
  for (let i = 0; i < firstLine.length; i++) hash = ((hash << 5) + hash + firstLine.charCodeAt(i)) | 0
  const cols = Math.max(0, splitRow(firstLine).length)
  return `${(hash >>> 0).toString(36)}:${cols}`
}

export function widthsForKey(key: string): number[] | undefined {
  return sessionWidths.get(key)
}

function saveWidths(key: string, widths: number[]): void {
  sessionWidths.set(key, widths)
  widthsDirty = true
  scheduleWidthsPersist()
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWidthsPersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!widthsDirty) return
    widthsDirty = false
    void window.electronAPI?.saveTableWidths(widthsDocPath, Object.fromEntries(sessionWidths))
  }, 800)
}

/** 换文档时由外壳调用：先把旧文档的宽度落盘，再装载新文档的存档。 */
export function loadTableWidthsFor(path: string | null): void {
  flushWidths()
  widthsDocPath = path
  if (!rememberTableWidths || !path || !window.electronAPI?.getTableWidths) {
    sessionWidths.clear()
    return
  }
  void window.electronAPI.getTableWidths(path).then((stored) => {
    // 装载期间用户可能又切了文档：只认还停在同一个文档时的结果
    if (widthsDocPath !== path) return
    sessionWidths.clear()
    for (const [key, widths] of Object.entries(stored ?? {})) {
      if (Array.isArray(widths) && widths.every((w) => typeof w === 'number')) {
        sessionWidths.set(key, widths.map((w) => Math.min(95, Math.max(5, w))))
      }
    }
  })
}

function flushWidths(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!widthsDirty) return
  widthsDirty = false
  void window.electronAPI?.saveTableWidths(widthsDocPath, Object.fromEntries(sessionWidths))
}

/**
 * 给渲染好的表格装上列宽：有存档的上 colgroup，再给每个表头挂拖拽把手。
 * 由 live-preview 的 TableWidget.toDOM 调用。
 */
export function attachColumnResize(table: HTMLTableElement, source: string): void {
  const key = tableWidthKey(source)
  const model = parseTableModel(source)
  const colCount = model?.aligns.length ?? 0
  if (colCount === 0) return

  let colgroup = table.querySelector('colgroup')
  if (!colgroup) {
    colgroup = document.createElement('colgroup')
    table.insertBefore(colgroup, table.firstChild)
    for (let c = 0; c < colCount; c++) colgroup.appendChild(document.createElement('col'))
  }
  const cols = Array.from(colgroup.children) as HTMLTableColElement[]
  const saved = rememberTableWidths ? widthsForKey(key) : undefined
  if (saved && saved.length === colCount) {
    saved.forEach((percent, c) => { cols[c].style.width = `${percent}%` })
  }

  const headerCells = Array.from(table.querySelectorAll('thead th'))
  headerCells.forEach((th, index) => {
    const handle = document.createElement('div')
    handle.className = 'cm-md-col-resizer'
    handle.dataset.col = String(index)
    th.appendChild(handle)
  })

  table.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement
    const handle = target.closest('.cm-md-col-resizer') as HTMLElement | null
    if (!handle || !table.isConnected) return
    event.preventDefault()
    event.stopPropagation()
    const colIndex = Number(handle.dataset.col)
    startColumnDrag(table, cols, key, colIndex, event)
  })
}

function startColumnDrag(
  table: HTMLTableElement,
  cols: HTMLTableColElement[],
  key: string,
  colIndex: number,
  start: MouseEvent,
): void {
  const tableWidth = table.getBoundingClientRect().width || 1
  const current = (): number[] => cols.map((col, index) => {
    const parsed = Number.parseFloat(col.style.width)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    return 100 / cols.length * (index === colIndex ? 1.4 : 1) // 没存过宽度时给被拖列多一点基线
  })
  let widths = current()
  const normalize = (values: number[]): void => {
    const total = values.reduce((sum, value) => sum + value, 0) || 1
    values = values.map((value) => (value / total) * 100)
  }
  normalize(widths)

  const onMove = (event: MouseEvent): void => {
    const deltaPercent = ((event.clientX - start.clientX) / tableWidth) * 100
    const next = [...widths]
    const min = 5
    next[colIndex] = Math.max(min, widths[colIndex] + deltaPercent)
    if (colIndex + 1 < next.length) {
      next[colIndex + 1] = Math.max(min, widths[colIndex + 1] - deltaPercent)
    }
    normalize(next)
    next.forEach((percent, index) => { cols[index].style.width = `${percent}%` })
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    const final = cols.map((col) => Number.parseFloat(col.style.width)).filter((value) => Number.isFinite(value))
    if (final.length === cols.length) saveWidths(key, final.map((value) => Math.round(value * 10) / 10))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
