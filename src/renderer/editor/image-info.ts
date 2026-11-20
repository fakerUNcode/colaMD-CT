// ColaMD CT：图片信息卡。
//
// 点一下渲染出来的图片，不再直接退源码，而是浮出一张信息卡：名称、Alt、地址
// （绝对路径 + 文件里写的原始相对路径）、像素尺寸、本地文件大小。「编辑地址」
// 才把光标放进源码那一行（旧点击行为）。卡是单例，点外面 / Esc / 滚动即收。

import type { EditorView } from '@codemirror/view'
import { isChinese } from '../ui-language'

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

/** 从 `![alt](src)` 源码里取 alt 与原始地址。 */
function parseImageSource(source: string): { alt: string; src: string } | null {
  const match = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)$/.exec(source.trim())
  return match ? { alt: match[1], src: match[2] } : null
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
  const zh = isChinese()
  const t = {
    title: zh ? '图片信息' : 'Image',
    name: zh ? '名称' : 'Name',
    alt: 'Alt',
    path: zh ? '地址' : 'Path',
    size: zh ? '尺寸' : 'Dimensions',
    fileSize: zh ? '大小' : 'File size',
    edit: zh ? '编辑地址' : 'Edit source',
    close: zh ? '关闭' : 'Close',
    unknown: zh ? '未知' : 'unknown',
  }

  const parsed = Number.isFinite(from) && Number.isFinite(to)
    ? parseImageSource(view.state.doc.sliceString(from, to))
    : null
  const absolute = img.src
  let name = t.unknown
  try {
    const rawSrc = parsed?.src ?? absolute
    name = decodeURIComponent(rawSrc.replace(/^.*[/\\]/, '').replace(/^<|>$/g, '')) || t.unknown
  } catch { name = rawName(parsed?.src ?? absolute) }
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
    rowOf(t.alt, parsed?.alt || (img.alt || '—')),
    rowOf(t.path, absolute),
    rowOf(t.size, displaySize),
  )
  if (parsed && parsed.src !== absolute) {
    // 文件里写的是相对路径：两条都给，看得出「写的是什么、实际读的是哪个文件」
    body.append(rowOf(zh ? '源码路径' : 'Markdown src', parsed.src))
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
  const edit = document.createElement('button')
  edit.className = 'math-modal-btn cancel'
  edit.textContent = t.edit
  edit.addEventListener('click', () => {
    closeCard()
    if (!Number.isFinite(from)) return
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
    view.focus()
  })
  footer.append(edit)

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

function rawName(src: string): string {
  return src.replace(/^.*[/\\]/, '') || 'unknown'
}
