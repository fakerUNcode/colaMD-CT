// ColaMD CT：图片输入——粘贴、拖拽、「插入图片」命令共用的管线。
//
// 流程分两段（Typora 同款手感）：
//   1. 键落成占位符：先在光标处插入 `![alt](colamd-ct:uploading-N)`，用户的
//      后续操作不用等上传；
//   2. 主进程摄取（上传/复制/引用）完成后，把占位符整体替换成最终地址。
//      上传期间用户可能改了文档、切了标签，替换按「占位符文本全文」查找，
//      找不到（被删了/换了文档）就静默放弃，绝不按旧坐标硬写。
//
// 文本口味里带 <img> 的网页粘贴（无文件）直接按引用插入 URL，不走上传。

import type { EditorView } from '@codemirror/view'
import { isChinese } from '../ui-language'

interface ImageFileInput {
  name: string
  mime: string
  bytes: ArrayBuffer
  sourcePath?: string | null
}

export interface PickedImage {
  name: string
  mime: string
  bytes: ArrayBuffer
  sourcePath: string
}

type IngestBehavior = 'upload' | 'copy' | 'reference'

/** 文档路径由外壳注册进来（外壳才知道当前标签页指向哪个文件）。 */
let docPathProvider: () => string | null = () => null
export function setImageDocPathProvider(provider: () => string | null): void {
  docPathProvider = provider
}

/** 完成替换时要用到「当前」view；由 core.ts 在建 view 时登记。 */
let hostView: EditorView | null = null
export function setImageViewHost(view: EditorView | null): void {
  hostView = view
}

let tokenCounter = 0

function altOf(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim()
  return (stem || 'image').replace(/[[\]]/g, '')
}

function placeholderSrc(): string {
  return `colamd-ct:uploading-${++tokenCounter}`
}

// ─── 阶段 2：摄取完成，替换占位符 ─────────────────────────────────────────────

function replacePlaceholder(placeholder: string, src: string): void {
  const view = hostView
  if (!view) return
  const doc = view.state.doc
  const full = doc.sliceString(0, doc.length)
  const at = full.indexOf(placeholder)
  if (at < 0) return // 用户删掉了占位符，或已切到别的文档：放弃这次替换
  const alt = /^!\[([^\]]*)\]/.exec(placeholder)?.[1] ?? 'image'
  view.dispatch({
    changes: { from: at, to: at + placeholder.length, insert: `![${alt}](${src})` },
  })
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null
/** 上传失败降级、无法保存等提示：借页面右下角一块临时浮层，3.5s 自散。 */
function showNotice(text: string): void {
  let host = document.getElementById('colamd-ct-notice')
  if (!host) {
    host = document.createElement('div')
    host.id = 'colamd-ct-notice'
    document.body.appendChild(host)
  }
  host.textContent = text
  host.hidden = false
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { host!.hidden = true }, 3500)
}

// ─── 询问弹窗（insertBehavior = ask 时）──────────────────────────────────────

function askBehavior(files: ImageFileInput[]): Promise<IngestBehavior | null> {
  return new Promise((resolve) => {
    const zh = isChinese()
    const t = {
      title: zh ? '插入图片' : 'Insert image',
      question: files.length > 1
        ? (zh ? `插入 ${files.length} 张图片：` : `Insert ${files.length} images:`)
        : (zh ? '插入这张图片：' : 'Insert this image:'),
      upload: zh ? '上传到图床' : 'Upload to image host',
      copy: zh ? '复制到文档目录' : 'Copy to document folder',
      reference: zh ? '保留原路径' : 'Keep original path',
      remember: zh ? '记住选择（可在偏好设置里改）' : 'Remember (change in Preferences)',
      cancel: zh ? '取消' : 'Cancel',
    }
    const overlay = document.createElement('div')
    overlay.className = 'math-modal-overlay'
    const modal = document.createElement('div')
    modal.className = 'math-modal colamd-ask-modal'
    const header = document.createElement('h3')
    header.textContent = t.title
    const question = document.createElement('div')
    question.className = 'colamd-ask-question'
    question.textContent = t.question
    const buttons = document.createElement('div')
    buttons.className = 'colamd-ask-buttons'
    const finish = (behavior: IngestBehavior | null, remember: boolean): void => {
      overlay.remove()
      if (behavior && remember) {
        window.electronAPI?.updateSettings({ image: { insertBehavior: behavior, rememberChoice: true } })
      }
      resolve(behavior)
    }
    const makeButton = (label: string, behavior: IngestBehavior, enabled: boolean): HTMLButtonElement => {
      const button = document.createElement('button')
      button.className = 'math-modal-btn'
      button.textContent = label
      button.disabled = !enabled
      button.addEventListener('click', () => finish(behavior, rememberBox.checked))
      return button
    }
    // 保留原路径只在确有源文件路径时说得通（剪贴板截图没有「原路径」）
    const hasSource = files.some((file) => !!file.sourcePath)
    buttons.append(
      makeButton(t.upload, 'upload', true),
      makeButton(t.copy, 'copy', true),
      makeButton(t.reference, 'reference', hasSource),
    )
    const rememberRow = document.createElement('label')
    rememberRow.className = 'colamd-ask-remember'
    const rememberBox = document.createElement('input')
    rememberBox.type = 'checkbox'
    rememberRow.append(rememberBox, document.createTextNode(t.remember))
    const cancel = document.createElement('button')
    cancel.className = 'math-modal-btn colamd-ask-cancel'
    cancel.textContent = t.cancel
    cancel.addEventListener('click', () => finish(null, false))
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null, false)
    })
    modal.append(header, question, buttons, rememberRow, cancel)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
  })
}

// ─── 阶段 1：插占位符 → 摄取 → 替换 ──────────────────────────────────────────

async function ingestAndReplace(placeholder: string, file: ImageFileInput, behavior: IngestBehavior): Promise<void> {
  const api = window.electronAPI
  if (api?.ingestImage) {
    const result = await api.ingestImage({
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
      docPath: docPathProvider(),
      sourcePath: file.sourcePath ?? null,
    }, behavior)
    if (result.ok) {
      replacePlaceholder(placeholder, result.src)
      if (result.warning) showNotice(result.warning)
    } else {
      showNotice(result.error)
    }
    return
  }
  // Web 演示版没有主进程：直接内联成 data URL
  const blob = new Blob([file.bytes], { type: file.mime })
  const reader = new FileReader()
  reader.addEventListener('load', () => {
    if (typeof reader.result === 'string') replacePlaceholder(placeholder, reader.result)
  })
  reader.readAsDataURL(blob)
}

/** 插入一组图片：先落占位符，再按设置（或询问结果）摄取。 */
export async function insertImages(view: EditorView, files: ImageFileInput[], pos?: number): Promise<void> {
  if (files.length === 0) return
  const at = pos ?? view.state.selection.main.to
  const entries = files.map((file) => {
    const src = placeholderSrc()
    const placeholder = `![${altOf(file.name)}](${src})`
    return { placeholder, file }
  })
  const text = entries.map((entry) => entry.placeholder).join(' ') + ' '
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
  })

  let behavior: IngestBehavior | null = null
  const settings = await window.electronAPI?.getSettings()
  if (!settings || settings.image.insertBehavior === 'ask') {
    behavior = await askBehavior(files)
    if (!behavior) return // 用户取消：占位符留着（可手动删），不动磁盘不上传
  } else {
    behavior = settings.image.insertBehavior === 'reference' ? 'reference' : settings.image.insertBehavior
  }

  // 并发摄取：多图一起传，谁先回来谁先替换
  for (const { placeholder, file } of entries) {
    void ingestAndReplace(placeholder, file, behavior)
  }
}

/** 「插入图片…」命令（Ctrl+Shift+I）：主进程对话框选完文件后从这里进。 */
export function insertPickedImages(view: EditorView, picked: PickedImage[]): void {
  void insertImages(view, picked)
}

// ─── 非图片文件 → 链接（拖入 / 粘贴）─────────────────────────────────────────
//
// 拖一个 .md / .pdf / 任意文件进正文，要的是「链接到它」，不是把内容粘进来，
// 也不是把当前文档整个换成它（那是拖到非编辑区的行为）。链接地址能写成相对
// 就写相对（同盘符才做得到），否则用绝对路径；空格转 %20 与图片同一规矩。

function linkForFile(filePath: string): string | null {
  const posix = filePath.replaceAll('\\', '/')
  const name = (posix.split('/').pop() ?? '').replace(/[[\]]/g, '')
  if (!name) return null
  const docPath = docPathProvider()
  let target = posix
  if (docPath) {
    const docPosix = docPath.replaceAll('\\', '/')
    const dir = docPosix.slice(0, docPosix.lastIndexOf('/'))
    const t = posix.split('/')
    const f = dir.split('/')
    if (t.length > 1 && f.length > 1 && t[0] === f[0]) {
      let i = 1
      while (i < t.length && i < f.length && t[i] === f[i]) i++
      const up = f.length - i
      target = [...Array<string>(up).fill('..'), ...t.slice(i)].join('/')
    }
  }
  return `[${name}](${target.replaceAll(' ', '%20')})`
}

/** 把一组非图片文件写成链接插到指定位置。 */
function insertFileLinks(view: EditorView, paths: string[], pos: number): boolean {
  const links = paths.map(linkForFile).filter((link): link is string => link !== null)
  if (links.length === 0) return false
  const text = `${links.join(' ')} `
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  })
  return true
}

// ─── CodeMirror DOM 事件接管 ─────────────────────────────────────────────────

const IMAGE_MIME = /^image\//i

async function fileToInput(file: File): Promise<ImageFileInput> {
  const bytes = await file.arrayBuffer()
  return {
    name: file.name,
    mime: file.type || 'image/png',
    bytes,
    sourcePath: window.electronAPI?.getPathForFile(file) ?? null,
  }
}

/** 网页里「复制图片」带来的 <img src="https://...">：按引用直接插。 */
function imageUrlFromHtml(data: DataTransfer | null): string | null {
  const html = data?.getData('text/html')
  if (!html || html.length > 1_000_000) return null
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html)
  const src = match?.[1] ?? null
  if (!src) return null
  if (/^https?:\/\//i.test(src)) return src
  if (/^data:image\//i.test(src) && src.length < 200_000) return src
  return null
}

export const imageInputHandlers = {
  paste(event: ClipboardEvent, view: EditorView): boolean {
    const data = event.clipboardData
    if (!data) return false
    const files = Array.from(data.files ?? [])
    const imageFiles = files.filter((file) => IMAGE_MIME.test(file.type))
    if (imageFiles.length === 0) {
      // 复制的非图片文件（Ctrl+C 一个 .md / .pdf）→ 插文件链接
      const otherPaths = files.map((file) => window.electronAPI?.getPathForFile(file) ?? '').filter(Boolean)
      if (otherPaths.length > 0) {
        event.preventDefault()
        insertFileLinks(view, otherPaths, view.state.selection.main.to)
        return true
      }
      const url = imageUrlFromHtml(data)
      if (!url) return false
      event.preventDefault()
      const at = view.state.selection.main.to
      view.dispatch({
        changes: { from: at, insert: `![](${url}) ` },
        selection: { anchor: at + url.length + 6 },
      })
      return true
    }
    event.preventDefault()
    void (async () => {
      const inputs = await Promise.all(imageFiles.map(fileToInput))
      await insertImages(view, inputs)
    })()
    return true
  },

  drop(event: DragEvent, view: EditorView): boolean {
    const data = event.dataTransfer
    if (!data) return false
    const files = Array.from(data.files ?? [])
    const imageFiles = files.filter((file) => IMAGE_MIME.test(file.type))
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.to
    if (imageFiles.length > 0) {
      // 图片拖进正文 = 走图片管线（上传/复制/引用）
      event.preventDefault()
      void (async () => {
        const inputs = await Promise.all(imageFiles.map(fileToInput))
        await insertImages(view, inputs, pos)
      })()
      return true
    }
    // 其他文件拖进正文 = 插文件链接（不粘内容、不换文档）；
    // 拖到正文之外（文件面板等）仍走外壳的「拖拽打开文档」
    const paths = files.map((file) => window.electronAPI?.getPathForFile(file) ?? '').filter(Boolean)
    if (paths.length === 0) return false
    event.preventDefault()
    insertFileLinks(view, paths, pos)
    return true
  },
}
