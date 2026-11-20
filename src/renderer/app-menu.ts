// ColaMD CT：Windows 标题栏的应用菜单（汉堡按钮）。
//
// 官方版弹的是**原生菜单**——系统灰、不跟主题、和自绘的界面格格不入。这里换成
// 自绘的 DOM 面板：颜色全部走主题的 CSS 变量，深浅色主题自动跟随；按功能分区
// （文档 / 视图 / 导出 / 系统），「偏好设置」按用户要求单独占一行置顶强调。
//
// 行为路由：菜单项动作经 app-menu-action IPC 转发到既有 channel（menu-save、
// toggle-source-mode…），渲染端已经注册的那些监听器原样复用——自绘菜单和原生
// 菜单（快捷键仍由它注册）行为永远一致，不用维护两套。
//
// 原生菜单仍然注册着：快捷键（Ctrl+S 等）靠它生效，自绘面板只是它的「脸」。

import { isChinese } from './ui-language'

interface MenuItemSpec {
  label: string
  /** 动作：channel + 参数，经主进程转发到既有监听器；preferences 等本地的直接给 fn。 */
  channel?: string
  args?: unknown[]
  fn?: () => void
  hint?: string
  flyout?: () => HTMLElement
}

interface MenuSectionSpec {
  label?: string
  items: MenuItemSpec[]
}

const THEME_LABELS: [string, string, string][] = [
  // id, 中文, English——与主进程菜单同一套名字
  ['light', '浅色', 'Light'],
  ['elegant', '雅致', 'Elegant'],
  ['notion', '简白', 'Notion'],
  ['writer', '作家', 'Writer'],
  ['bear', '熊红', 'Bear'],
  ['sepia', '羊皮纸', 'Sepia'],
  ['dark', '深色', 'Dark'],
  ['gruvbox', '暖木', 'Gruvbox'],
  ['midnight', '午夜', 'Midnight'],
  ['solarized-dark', '夜航', 'Solarized Dark'],
  ['nord', '极地', 'Nord'],
  ['dracula', '德古拉', 'Dracula'],
]

let panel: HTMLElement | null = null
let flyout: HTMLElement | null = null
let dismissOnDocDown: ((e: MouseEvent) => void) | null = null
let dismissOnKey: ((e: KeyboardEvent) => void) | null = null
let dismissOnBlur: (() => void) | null = null

/** 当前的主题/语言由外壳注册进来（它们才知道活状态）。 */
let currentTheme: () => string = () => 'elegant'
let currentLanguage: () => 'zh' | 'en' = () => 'zh'
let onPreferences: () => void = () => {}

export function setupAppMenu(hooks: {
  theme: () => string
  language: () => 'zh' | 'en'
  preferences: () => void
}): void {
  currentTheme = hooks.theme
  currentLanguage = hooks.language
  onPreferences = hooks.preferences
}

function closeMenu(): void {
  if (dismissOnDocDown) document.removeEventListener('mousedown', dismissOnDocDown, true)
  if (dismissOnKey) document.removeEventListener('keydown', dismissOnKey, true)
  if (dismissOnBlur) window.removeEventListener('blur', dismissOnBlur)
  dismissOnDocDown = null
  dismissOnKey = null
  dismissOnBlur = null
  closeFlyout()
  panel?.remove()
  panel = null
}

function closeFlyout(): void {
  flyout?.remove()
  flyout = null
}

function fire(item: MenuItemSpec): void {
  closeMenu()
  if (item.fn) {
    item.fn()
    return
  }
  if (item.channel) {
    void window.electronAPI?.appMenuAction(item.channel, ...(item.args ?? []))
  }
}

/** 二级面板（主题 / 语言）：与主面板同一套视觉，出现时盖在右侧。 */
function openFlyout(item: MenuItemSpec, anchorRow: HTMLElement): void {
  closeFlyout()
  const content = item.flyout?.()
  if (!content || !panel) return
  flyout = document.createElement('div')
  flyout.className = 'colamd-menu colamd-menu-flyout'
  flyout.appendChild(content)
  document.body.appendChild(flyout)
  const buttonRect = document.getElementById('app-menu-btn')?.getBoundingClientRect()
  const rowRect = anchorRow.getBoundingClientRect()
  const flyRect = flyout.getBoundingClientRect()
  const left = Math.min((buttonRect?.right ?? rowRect.right) + 6, window.innerWidth - flyRect.width - 8)
  flyout.style.left = `${Math.max(8, left)}px`
  flyout.style.top = `${Math.min(rowRect.top, window.innerHeight - flyRect.height - 8)}px`
}

function themeFlyout(): HTMLElement {
  const zh = isChinese()
  const current = currentTheme()
  const list = document.createElement('div')
  list.className = 'colamd-menu-list'
  for (const [id, zhName, enName] of THEME_LABELS) {
    const row = document.createElement('button')
    row.className = 'colamd-menu-item'
    row.type = 'button'
    const name = document.createElement('span')
    name.className = 'colamd-menu-label'
    name.textContent = zh ? zhName : enName
    row.appendChild(name)
    if (current === id) row.appendChild(checkMark())
    row.addEventListener('click', () => {
      closeMenu()
      void window.electronAPI?.appMenuAction('set-theme', id)
    })
    list.appendChild(row)
  }
  return list
}

function languageFlyout(): HTMLElement {
  const zh = isChinese()
  const current = currentLanguage()
  const list = document.createElement('div')
  list.className = 'colamd-menu-list'
  for (const [id, label] of [['zh', '中文'], ['en', 'English']] as const) {
    const row = document.createElement('button')
    row.className = 'colamd-menu-item'
    row.type = 'button'
    const name = document.createElement('span')
    name.className = 'colamd-menu-label'
    name.textContent = label
    row.appendChild(name)
    if (current === id) row.appendChild(checkMark())
    row.addEventListener('click', () => {
      closeMenu()
      void window.electronAPI?.setLanguage(id)
    })
    list.appendChild(row)
  }
  return list
}

function checkMark(): HTMLElement {
  const mark = document.createElement('span')
  mark.className = 'colamd-menu-check'
  mark.textContent = '✓'
  return mark
}

/** 汉堡按钮点击：开/关。由 main.ts 接线。 */
export function toggleAppMenu(): void {
  if (panel) {
    closeMenu()
    return
  }
  const zh = isChinese()
  const t = {
    preferences: zh ? '偏好设置…' : 'Preferences…',
    doc: zh ? '文档' : 'Document',
    open: zh ? '打开…' : 'Open…',
    save: zh ? '保存' : 'Save',
    saveAs: zh ? '另存为…' : 'Save As…',
    newTab: zh ? '新建标签页' : 'New Tab',
    closeTab: zh ? '关闭标签页' : 'Close Tab',
    view: zh ? '视图' : 'View',
    source: zh ? 'Markdown 源码' : 'Markdown Source',
    fileList: zh ? '文件列表' : 'File List',
    theme: zh ? '主题' : 'Theme',
    language: zh ? '界面语言' : 'Language',
    export: zh ? '导出' : 'Export',
    exportPDF: zh ? '导出 PDF…' : 'Export PDF…',
    exportHTML: zh ? '导出 HTML…' : 'Export HTML…',
    exportWord: zh ? '导出 Word…' : 'Export Word…',
    exportImageDesktop: zh ? '图片（电脑阅读）…' : 'Image (Desktop)…',
    exportImageMobile: zh ? '图片（手机阅读）…' : 'Image (Mobile)…',
    setDefault: zh ? '设为默认应用…' : 'Set as Default…',
    cheatsheet: zh ? 'Markdown 语法' : 'Markdown Syntax',
    whatsNew: zh ? '新功能演示' : "What's New",
  }

  const sections: MenuSectionSpec[] = [
    {
      items: [
        // 偏好设置单独一行、置顶强调：改图床、改快捷键都从这里进
        {
          label: t.preferences,
          hint: 'Ctrl+,',
          fn: onPreferences,
        },
      ],
    },
    {
      label: t.doc,
      items: [
        { label: t.open, channel: 'menu-open', hint: 'Ctrl+O' },
        { label: t.save, channel: 'menu-save', hint: 'Ctrl+S' },
        { label: t.saveAs, channel: 'menu-save-as', hint: 'Ctrl+Shift+S' },
        { label: t.newTab, channel: 'menu-new-tab', hint: 'Ctrl+T' },
        { label: t.closeTab, channel: 'menu-close-tab', hint: 'Ctrl+W' },
      ],
    },
    {
      label: t.view,
      items: [
        { label: t.source, channel: 'toggle-source-mode', hint: 'Ctrl+/' },
        { label: t.fileList, channel: 'toggle-file-panel', hint: 'Ctrl+\\' },
        { label: t.theme, flyout: themeFlyout },
        { label: t.language, flyout: languageFlyout },
      ],
    },
    {
      label: t.export,
      items: [
        { label: t.exportPDF, channel: 'menu-export-pdf' },
        { label: t.exportHTML, channel: 'menu-export-html' },
        { label: t.exportWord, channel: 'menu-export-docx' },
        { label: t.exportImageDesktop, channel: 'menu-export-image', args: ['desktop'] },
        { label: t.exportImageMobile, channel: 'menu-export-image', args: ['mobile'] },
      ],
    },
    {
      items: [
        { label: t.setDefault, fn: () => void window.electronAPI?.setDefaultApp() },
        { label: t.cheatsheet, fn: () => void window.electronAPI?.openCheatsheet(), hint: 'Ctrl+Shift+/' },
        { label: t.whatsNew, fn: () => void window.electronAPI?.openWhatsNew(), hint: 'Ctrl+Shift+D' },
      ],
    },
  ]

  panel = document.createElement('div')
  panel.className = 'colamd-menu colamd-menu-panel'
  panel.setAttribute('role', 'menu')

  sections.forEach((section, index) => {
    if (index > 0) {
      const divider = document.createElement('div')
      divider.className = 'colamd-menu-divider'
      panel!.appendChild(divider)
    }
    if (section.label) {
      const head = document.createElement('div')
      head.className = 'colamd-menu-section'
      head.textContent = section.label
      panel!.appendChild(head)
    }
    for (const item of section.items) {
      const row = document.createElement('button')
      row.className = `colamd-menu-item${index === 0 ? ' colamd-menu-item-primary' : ''}`
      row.type = 'button'
      row.setAttribute('role', 'menuitem')
      const label = document.createElement('span')
      label.className = 'colamd-menu-label'
      label.textContent = item.label
      row.appendChild(label)
      if (item.flyout) {
        const arrow = document.createElement('span')
        arrow.className = 'colamd-menu-arrow'
        arrow.textContent = '›'
        row.appendChild(arrow)
        row.classList.add('colamd-menu-has-flyout')
        row.addEventListener('mouseenter', () => openFlyout(item, row))
      } else {
        if (item.hint) {
          const hint = document.createElement('span')
          hint.className = 'colamd-menu-hint'
          hint.textContent = item.hint
          row.appendChild(hint)
        }
        row.addEventListener('click', () => fire(item))
        row.addEventListener('mouseenter', () => closeFlyout())
      }
      panel!.appendChild(row)
    }
  })

  document.body.appendChild(panel)
  const button = document.getElementById('app-menu-btn')
  const buttonRect = button?.getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  const left = Math.max(8, Math.min(buttonRect?.left ?? 8, window.innerWidth - panelRect.width - 8))
  panel.style.left = `${left}px`
  panel.style.top = `${Math.min((buttonRect?.bottom ?? 36) + 6, window.innerHeight - panelRect.height - 8)}px`

  dismissOnDocDown = (event: MouseEvent): void => {
    const target = event.target as Node
    if (panel?.contains(target) || flyout?.contains(target) || button?.contains(target)) return
    closeMenu()
  }
  dismissOnKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeMenu()
  }
  dismissOnBlur = (): void => closeMenu()
  document.addEventListener('mousedown', dismissOnDocDown, true)
  document.addEventListener('keydown', dismissOnKey, true)
  window.addEventListener('blur', dismissOnBlur)
}
