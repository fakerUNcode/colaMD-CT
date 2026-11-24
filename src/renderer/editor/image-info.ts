// ColaMD CT：图片信息卡与右键菜单。
//
// 点一下渲染出来的图片，不再直接退源码，而是浮出一张信息卡：名称、Alt、地址
// （绝对路径 + 文件里写的原始相对路径）、像素尺寸、宽度设置、本地文件大小。「编辑地址」
// 才把光标放进源码那一行（旧点击行为）。卡是单例，点外面 / Esc / 滚动即收。
//
// 右键菜单（2026-11-24 用户报「图片无右键菜单，不能进行大小缩放等功能」）：原生菜单，
// Typora 的那一套——放大 / 缩小 / 恢复原始大小、复制图片、复制图片地址、打开图片、
// 在文件夹中显示、另存为、编辑地址、图片信息。
//
//   - 缩放写回源码：`![图](a.png)` → `<img src="a.png" alt="图" width="300">`（见
//     shared/image-syntax），是一次可撤销的文本改动，重开文件还在；表格格子里的图片同理。
//   - 复制 / 打开 / 定位 / 另存不碰文档，由主进程直接做（菜单在主进程搭）。
//   - 改文档的那几个动作经 image-menu-action 发回渲染端，这里执行。

import type { EditorView } from '@codemirror/view'
import { isChinese } from '../ui-language'
import { imageSource, writeImageWidth, type ImageMenuRequest } from '../../shared/image-syntax'

let card: HTMLElement | null = null
let dismissOnDocMouseDown: ((e: MouseEvent) => void) | null = null
let dismissOnKey: ((e: KeyboardEvent) => void) | null = null
let dismissOnScroll: (() => void) | null = null

function closeCard(): void {
  if (dismissOnDocMouseDown) document.removeEventListener('mousedown', dismissOnDocMouseDown, true)
  if (dismissOnKey) document.removeEventListener('keydown', dismissOnKey, true)
  if (dismissOnScroll) document.removeEventListener('scroll', dismissOnScroll, true)
  dismissOnDocMouseDown = null
  dismissOnKey = null
  dismissOnScroll = null
  card?.remove()
  card = null
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 某个图片 widget 在文档里的源码区间与解析结果；不是图片（或区间已失效）返回 null。 */
function sourceAt(view: EditorView, from: number, to: number) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > view.state.doc.length || from >= to) return null
  return imageSource(view.state.doc.sliceString(from, to))
}

function rawName(src: string): string {
  return src.replace(/^.*[/\\]/, '') || 'unknown'
}

function rowOf(label: string, value: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'colamd-image-info-row'
  const name = document.createElement('span')
  name.className = 'colamd-image-info-name'
  name.textContent = label
  const valueEl = document.createElement('span')
  valueEl.className = 'colamd-image-info-value'
  valueEl.textContent = value
  valueEl.title = value
  row.append(name, valueEl)
  return row
}

/** editor.ts 的图片点击处理器调用。wrap 是带 data-source-from 的 .cm-md-image。 */
export function showImageInfoCard(view: EditorView, wrap: HTMLElement): void {
  closeCard()
  const img = wrap.querySelector('img')
  if (!img) return
  const from = Number(wrap.dataset.sourceFrom)
  const to = Number(wrap.dataset.sourceTo)
  const info = sourceAt(view, from, to)
  const zh = isChinese()
  const t = {
    title: zh ? '图片信息' : 'Image',
    name: zh ? '名称' : 'Name',
    alt: 'Alt',
    path: zh ? '地址' : 'Path',
    size: zh ? '尺寸' : 'Dimensions',
    width: zh ? '显示宽度' : 'Width',
    auto: zh ? '自动（按图片自身大小）' : 'Auto (natural size)',
    fileSize: zh ? '大小' : 'File size',
    edit: zh ? '编辑地址' : 'Edit source',
    close: zh ? '关闭' : 'Close',
    unknown: zh ? '未知' : 'unknown',
  }

  const absolute = img.src
  let name = t.unknown
  try {
    const rawSrc = info?.src ?? absolute
    name = decodeURIComponent(rawName(rawSrc.replace(/^<|>$/g, ''))) || t.unknown
  } catch { name = rawName(info?.src ?? absolute) }
  const displaySize = img.naturalWidth > 0 ? `${img.naturalWidth} × ${img.naturalHeight} px` : t.unknown

  card = document.createElement('div')
  card.className = 'colamd-image-info'
  const header = document.createElement('div')
  header.className = 'colamd-image-info-header'
  const title = document.createElement('span')
  title.textContent = t.title
  const close = document.createElement('button')
  close.className = 'colamd-image-info-close'
  close.setAttribute('aria-label', t.close)
  close.textContent = '×'
  close.addEventListener('click', closeCard)
  header.append(title, close)

  const body = document.createElement('div')
  body.className = 'colamd-image-info-body'
  body.append(
    rowOf(t.name, name),
    rowOf(t.alt, info?.alt || (img.alt || '—')),
    rowOf(t.path, absolute),
    rowOf(t.size, displaySize),
    rowOf(t.width, info?.width !== undefined ? `${info.width} px` : t.auto),
  )
  if (info && info.src !== absolute) {
    // 文件里写的是相对路径：两条都给，看得出「写的是什么、实际读的是哪个文件」
    body.append(rowOf(zh ? '源码路径' : 'Markdown src', info.src))
  }
  const sizeRow = rowOf(t.fileSize, '…')
  body.append(sizeRow)
  if (absolute.startsWith('file://')) {
    void window.electronAPI?.statImage(absolute).then((stat) => {
      if (!card || !stat) { sizeRow.querySelector('.colamd-image-info-value')!.textContent = '—'; return }
      sizeRow.querySelector('.colamd-image-info-value')!.textContent = humanSize(stat.size)
    })
  } else {
    sizeRow.querySelector('.colamd-image-info-value')!.textContent = '—'
  }

  const footer = document.createElement('div')
  footer.className = 'colamd-image-info-footer'
  const hint = document.createElement('span')
  hint.className = 'colamd-image-info-hint'
  hint.textContent = zh ? '右键图片可缩放' : 'Right-click to resize'
  const edit = document.createElement('button')
  edit.className = 'math-modal-btn cancel'
  edit.textContent = t.edit
  edit.addEventListener('click', () => {
    closeCard()
    if (!Number.isFinite(from)) return
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
    view.focus()
  })
  footer.append(hint, edit)

  card.append(header, body, footer)
  document.body.appendChild(card)

  // 落位：图片可见区域右上角，视口内夹住
  const rect = wrap.getBoundingClientRect()
  card.style.visibility = 'hidden'
  card.hidden = false
  requestAnimationFrame(() => {
    if (!card) return
    const cardRect = card.getBoundingClientRect()
    let left = Math.min(rect.right - cardRect.width, window.innerWidth - cardRect.width - 12)
    left = Math.max(12, left)
    let top = rect.top + 8
    if (top + cardRect.height > window.innerHeight - 12) top = Math.max(12, rect.bottom - cardRect.height - 8)
    card.style.left = `${left}px`
    card.style.top = `${top}px`
    card.style.visibility = ''
  })

  dismissOnDocMouseDown = (event: MouseEvent): void => {
    if (card && !card.contains(event.target as Node)) closeCard()
  }
  dismissOnKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeCard()
  }
  dismissOnScroll = (): void => closeCard()
  document.addEventListener('mousedown', dismissOnDocMouseDown, true)
  document.addEventListener('keydown', dismissOnKey, true)
  document.addEventListener('scroll', dismissOnScroll, true)
}

// ─── 右键菜单 ─────────────────────────────────────────────────────────────────

/** 最近一次右键的图片：放大 / 缩小要按它此刻显示的宽度算。 */
interface Target {
  from: number
  to: number
  displayed: number
  natural: number
  wrap: HTMLElement | null
}

let lastTarget: Target | null = null
/** 每一步缩放的比例。 */
const ZOOM_STEP = 1.25
/** 缩到的下限（像素）。 */
const MIN_WIDTH = 40

/** 验收脚本用它把菜单请求接走：真实应用里右键照常走到这里，只是不弹原生菜单。 */
let menuSink: ((request: ImageMenuRequest) => void) | null = null

export function setImageMenuSink(sink: ((request: ImageMenuRequest) => void) | null): void {
  menuSink = sink
}

/** editor.ts 的 contextmenu 处理器调用。wrap 是正文里带 data-source-from 的 .cm-md-image；表格格子里的图片没有。 */
export function showImageContextMenu(
  view: EditorView,
  target: { from: number; to: number; img: HTMLImageElement; wrap?: HTMLElement | null },
): void {
  const { from, to, img } = target
  const info = sourceAt(view, from, to)
  if (!info) return
  closeCard()
  const displayed = Math.round(img.getBoundingClientRect().width)
  const natural = img.naturalWidth || displayed
  const current = info.width ?? displayed
  lastTarget = { from, to, displayed, natural, wrap: target.wrap ?? null }
  const request: ImageMenuRequest = {
    from,
    to,
    src: img.src,
    rawSrc: info.src,
    local: img.src.startsWith('file:'),
    // 没设过宽度时不放大超过图片自身（放大会糊）；设过的以设的为准
    canZoomIn: current > 0 && current < natural,
    canZoomOut: current > MIN_WIDTH,
    canActualSize: info.width !== undefined,
    hasInfoCard: !!target.wrap,
  }
  if (menuSink) menuSink(request)
  else void window.electronAPI?.showImageContextMenu(request)
}

/**
 * 主进程菜单动作回发后的执行入口（外壳 main.ts 接线）。
 * 菜单是模态的，但文档在这期间理论上可能变过：重新按区间读源码，不是图片就不动。
 */
export function applyImageMenuAction(view: EditorView, from: number, to: number, action: string): boolean {
  const info = sourceAt(view, from, to)
  if (!info) return false
  if (action === 'editSource') {
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
    view.focus()
    return true
  }
  if (action === 'imageInfo') {
    if (lastTarget && lastTarget.from === from && lastTarget.to === to && lastTarget.wrap?.isConnected) {
      showImageInfoCard(view, lastTarget.wrap)
      return true
    }
    return false
  }
  if (action !== 'zoomIn' && action !== 'zoomOut' && action !== 'actualSize') return false
  const source = view.state.doc.sliceString(from, to)
  const measured = lastTarget && lastTarget.from === from && lastTarget.to === to ? lastTarget : null
  const current = info.width ?? measured?.displayed ?? 0
  let width: number | null
  if (action === 'actualSize') {
    width = null
  } else if (action === 'zoomIn') {
    if (!current || !measured?.natural) return false
    width = Math.min(Math.round(current * ZOOM_STEP), measured.natural)
    if (width <= current) return false
  } else {
    if (!current) return false
    width = Math.max(MIN_WIDTH, Math.round(current / ZOOM_STEP))
    if (width >= current) return false
  }
  const next = writeImageWidth(source, width)
  if (next === source) return false
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
  return true
}
