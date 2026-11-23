// ColaMD CT：Windows 标题栏的模块菜单。
//
// 官方版在标题栏只有一个汉堡按钮，点开是整张菜单（原生菜单弹出来）——「格式」埋在
// 编辑子菜单里，改个加粗要三次点击。这里换成**按功能拆分的五个模块按钮**：
//
//   文件  新建/打开/最近/保存/导出/默认应用
//   格式  加粗、斜体、标题、列表…——点一下立刻生效，一次点击到位
//   插入  链接、图片、表格、公式…
//   视图  源码模式、文件列表、主题、宽度、语言、字号、全屏
//   更多  偏好设置、语法、新功能、关于
//
// 每个按钮一个极简图标；点一下在按钮正下方展开该模块的面板；面板开着时悬停到
// 另一个模块按钮上直接切换（菜单栏的手感）。二级项（标题 1-6、主题、导出…）
// 悬停时在右侧展开。
//
// 行为路由：菜单项动作经 app-menu-action IPC 转发到既有 channel（menu-save、
// editor:format…），渲染端已注册的那些监听器原样复用——与原生菜单（快捷键仍由
// 它注册）行为永远一致，不用维护两套。格式命令的名称与快捷键提示取自
// src/shared/commands.ts，与偏好设置里的改绑同步。

import { EDITOR_COMMANDS } from '../shared/commands'
import { isChinese } from './ui-language'

export type MenuModule = 'file' | 'format' | 'insert' | 'view' | 'more'

export const MENU_MODULES: { id: MenuModule; zh: string; en: string }[] = [
  { id: 'file', zh: '文件', en: 'File' },
  { id: 'format', zh: '格式', en: 'Format' },
  { id: 'insert', zh: '插入', en: 'Insert' },
  { id: 'view', zh: '视图', en: 'View' },
  { id: 'more', zh: '更多', en: 'More' },
]

interface MenuItem {
  label: string
  /** 右侧的快捷键提示 */
  hint?: string
  /** 提示是文件路径（长路径从开头省略） */
  hintIsPath?: boolean
  /** 动作：channel + 参数，经主进程转发到既有监听器 */
  channel?: string
  args?: unknown[]
  /** 本地动作 */
  run?: () => void
  /** 二级面板（悬停展开） */
  items?: () => MenuItem[] | Promise<MenuItem[]>
  /** 勾选态（主题 / 宽度 / 语言） */
  checked?: () => boolean
  /** 置灰 */
  disabled?: () => boolean
}
interface MenuSection {
  section: string
}
type MenuEntry = MenuItem | MenuSection

interface Hooks {
  theme: () => string
  language: () => 'zh' | 'en'
  preferences: () => void
}

let hooks: Hooks = { theme: () => 'elegant', language: () => 'zh', preferences: () => {} }

/** 外壳注册活状态（当前主题/语言）与本地动作。 */
export function setupAppMenu(next: Hooks): void {
  hooks = next
}

// ─── 各模块的条目 ─────────────────────────────────────────────────────────────

const THEME_LABELS: [string, string, string][] = [
  ['light', '浅色', 'Light'], ['elegant', '雅致', 'Elegant'], ['notion', '简白', 'Notion'],
  ['writer', '作家', 'Writer'], ['bear', '熊红', 'Bear'], ['sepia', '羊皮纸', 'Sepia'],
  ['dark', '深色', 'Dark'], ['gruvbox', '暖木', 'Gruvbox'], ['midnight', '午夜', 'Midnight'],
  ['solarized-dark', '夜航', 'Solarized Dark'], ['nord', '极地', 'Nord'], ['dracula', '德古拉', 'Dracula'],
]

/** `CmdOrCtrl+Shift+X` → `Ctrl+Shift+X`（这排按钮只在 Windows 上出现）。 */
function displayAccelerator(accelerator: string): string | undefined {
  return accelerator ? accelerator.replace(/^CmdOrCtrl/, 'Ctrl') : undefined
}

/** 注册表里的格式命令：名称与快捷键提示跟着用户的改绑走。 */
function command(id: string, zh: boolean): MenuItem {
  const spec = EDITOR_COMMANDS.find((entry) => entry.id === id)
  return {
    label: spec ? (zh ? spec.zh : spec.en) : id,
    hint: spec ? displayAccelerator(spec.accelerator) : undefined,
    channel: 'editor:format',
    args: [id],
  }
}

function moduleEntries(module: MenuModule, zh: boolean): MenuEntry[] {
  const sep = (section: string): MenuSection => ({ section })
  switch (module) {
    case 'file':
      return [
        { label: zh ? '新建窗口' : 'New Window', hint: 'Ctrl+N', run: () => void window.electronAPI?.newWindow() },
        { label: zh ? '打开…' : 'Open…', hint: 'Ctrl+O', channel: 'menu-open' },
        {
          label: zh ? '最近打开' : 'Open Recent',
          items: async () => {
            const files = (await window.electronAPI?.getRecentFiles()) ?? []
            if (files.length === 0) return [{ label: zh ? '没有最近打开的文件' : 'No recent files', disabled: () => true }]
            // 同名文件靠目录区分：名字做标签，所在目录做右侧提示
            return files.map((path) => ({
              label: path.replace(/^.*[\\/]/, ''),
              hint: path.replace(/[\\/][^\\/]*$/, ''),
              hintIsPath: true,
              run: () => void window.electronAPI?.openFilePath(path),
            }))
          },
        },
        sep(zh ? '文档' : 'Document'),
        { label: zh ? '保存' : 'Save', hint: 'Ctrl+S', channel: 'menu-save' },
        { label: zh ? '另存为…' : 'Save As…', hint: 'Ctrl+Shift+S', channel: 'menu-save-as' },
        { label: zh ? '新建标签页' : 'New Tab', hint: 'Ctrl+T', channel: 'menu-new-tab' },
        { label: zh ? '关闭标签页' : 'Close Tab', hint: 'Ctrl+W', channel: 'menu-close-tab' },
        sep(zh ? '导出' : 'Export'),
        {
          label: zh ? '导出为…' : 'Export As…',
          items: () => [
            { label: zh ? 'PDF' : 'PDF', channel: 'menu-export-pdf' },
            { label: 'HTML', channel: 'menu-export-html' },
            { label: zh ? 'Word' : 'Word', channel: 'menu-export-docx' },
            { label: zh ? '图片（电脑阅读）' : 'Image (Desktop)', channel: 'menu-export-image', args: ['desktop'] },
            { label: zh ? '图片（手机阅读）' : 'Image (Mobile)', channel: 'menu-export-image', args: ['mobile'] },
          ],
        },
        sep(zh ? '系统' : 'System'),
        { label: zh ? '设为默认应用…' : 'Set as Default…', run: () => void window.electronAPI?.setDefaultApp() },
        { label: zh ? '关闭窗口' : 'Close Window', run: () => void window.electronAPI?.closeWindow() },
      ]
    case 'format':
      // 快速设置格式：每一条点下去立刻生效，不用层层进子菜单
      return [
        sep(zh ? '行内' : 'Inline'),
        command('bold', zh), command('italic', zh), command('underline', zh),
        command('inlineCode', zh), command('strikethrough', zh), command('highlight', zh),
        {
          label: zh ? '标题' : 'Heading',
          items: () => [
            command('heading1', zh), command('heading2', zh), command('heading3', zh),
            command('heading4', zh), command('heading5', zh), command('heading6', zh),
            command('paragraph', zh),
          ],
        },
        sep(zh ? '列表与块' : 'Lists & Blocks'),
        command('bulletList', zh), command('orderedList', zh), command('taskList', zh),
        command('quote', zh), command('codeBlock', zh), command('mathBlock', zh),
      ]
    case 'insert':
      return [
        command('link', zh), command('image', zh), command('table', zh),
        command('mathBlock', zh), command('codeBlock', zh), command('hr', zh),
      ]
    case 'view':
      return [
        { label: zh ? 'Markdown 源码' : 'Markdown Source', hint: 'Ctrl+/', channel: 'toggle-source-mode' },
        { label: zh ? '文件列表' : 'File List', hint: 'Ctrl+\\', channel: 'toggle-file-panel' },
        sep(zh ? '外观' : 'Appearance'),
        {
          label: zh ? '主题' : 'Theme',
          items: () => THEME_LABELS.map(([id, zhName, enName]) => ({
            label: zh ? zhName : enName,
            checked: () => hooks.theme() === id,
            channel: 'set-theme',
            args: [id],
          })),
        },
        {
          label: zh ? '正文宽度' : 'Text Width',
          items: () => (['narrow', 'standard', 'wide'] as const).map((width) => ({
            label: width === 'narrow' ? (zh ? '窄' : 'Narrow') : width === 'standard' ? (zh ? '标准' : 'Standard') : (zh ? '宽' : 'Wide'),
            checked: () => (localStorage.getItem('colamd-page-width') || 'standard') === width,
            channel: 'set-page-width',
            args: [width],
          })),
        },
        {
          label: zh ? '界面语言' : 'Language',
          items: () => (['zh', 'en'] as const).map((id) => ({
            label: id === 'zh' ? '中文' : 'English',
            checked: () => hooks.language() === id,
            run: () => void window.electronAPI?.setLanguage(id),
          })),
        },
        sep(zh ? '字号与显示' : 'Size & Display'),
        { label: zh ? '放大字号' : 'Larger Text', hint: 'Ctrl++', channel: 'step-font', args: [1] },
        { label: zh ? '缩小字号' : 'Smaller Text', hint: 'Ctrl+-', channel: 'step-font', args: [-1] },
        { label: zh ? '恢复默认字号' : 'Reset Text Size', hint: 'Ctrl+0', channel: 'step-font', args: [0] },
        { label: zh ? '切换全屏' : 'Toggle Full Screen', run: () => void window.electronAPI?.toggleFullscreen() },
        { label: zh ? '放映幻灯片' : 'Play Slides', hint: 'Ctrl+Shift+P', channel: 'menu-play-slideshow' },
      ]
    case 'more':
      return [
        { label: zh ? '偏好设置…' : 'Preferences…', hint: 'Ctrl+,', run: () => hooks.preferences() },
        { label: zh ? 'Markdown 语法' : 'Markdown Syntax', hint: 'Ctrl+Shift+/', run: () => void window.electronAPI?.openCheatsheet() },
        { label: zh ? '新功能演示' : "What's New", hint: 'Ctrl+Shift+D', run: () => void window.electronAPI?.openWhatsNew() },
        sep(zh ? '关于' : 'About'),
        {
          label: zh ? 'ColaMD CT（项目主页）' : 'ColaMD CT (project page)',
          run: () => void window.electronAPI?.openExternal('https://github.com/fakerUNcode/colaMD-CT'),
        },
      ]
  }
}

// ─── 面板 ─────────────────────────────────────────────────────────────────────

let panel: HTMLElement | null = null
/** 展开中的二级/三级面板（悬停切换时只保留到当前深度） */
let flyouts: HTMLElement[] = []
let openModule: MenuModule | null = null
let dismissOnDocDown: ((event: MouseEvent) => void) | null = null
let keepFocus: ((event: MouseEvent) => void) | null = null
let dismissOnKey: ((event: KeyboardEvent) => void) | null = null
let dismissOnBlur: (() => void) | null = null

function moduleButton(module: MenuModule): HTMLElement | null {
  return document.getElementById(`app-menu-btn-${module}`)
}

function closeMenu(): void {
  if (dismissOnDocDown) document.removeEventListener('mousedown', dismissOnDocDown, true)
  if (keepFocus) document.removeEventListener('mousedown', keepFocus, true)
  if (dismissOnKey) document.removeEventListener('keydown', dismissOnKey, true)
  if (dismissOnBlur) window.removeEventListener('blur', dismissOnBlur)
  dismissOnDocDown = null
  keepFocus = null
  dismissOnKey = null
  dismissOnBlur = null
  for (const flyout of flyouts) flyout.remove()
  flyouts = []
  panel?.remove()
  panel = null
  if (openModule) moduleButton(openModule)?.classList.remove('active')
  openModule = null
}

/** 收起第 depth 层及更深的二级面板。 */
function closeFlyoutsFrom(depth: number): void {
  while (flyouts.length > depth) flyouts.pop()!.remove()
}

function fire(item: MenuItem): void {
  closeMenu()
  if (item.run) {
    item.run()
    return
  }
  if (item.channel) void window.electronAPI?.appMenuAction(item.channel, ...(item.args ?? []))
}

function checkMark(): HTMLElement {
  const mark = document.createElement('span')
  mark.className = 'colamd-menu-check'
  mark.textContent = '✓'
  return mark
}

/** 把条目列表画进一个面板容器；返回容器。 */
function renderEntries(container: HTMLElement, entries: MenuEntry[], depth: number): void {
  for (const entry of entries) {
    if ('section' in entry) {
      if (container.childElementCount > 0) {
        const divider = document.createElement('div')
        divider.className = 'colamd-menu-divider'
        container.appendChild(divider)
      }
      const head = document.createElement('div')
      head.className = 'colamd-menu-section'
      head.textContent = entry.section
      container.appendChild(head)
      continue
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'colamd-menu-item'
    row.setAttribute('role', 'menuitem')
    if (entry.items && entry.disabled?.() !== true) row.classList.add('colamd-menu-has-flyout')
    const label = document.createElement('span')
    label.className = 'colamd-menu-label'
    label.textContent = entry.label
    row.appendChild(label)
    if (entry.checked?.()) row.appendChild(checkMark())
    const disabled = entry.disabled?.() === true
    if (disabled) {
      row.disabled = true
      row.classList.add('colamd-menu-item-disabled')
      container.appendChild(row)
      continue
    }
    if (entry.items) {
      const arrow = document.createElement('span')
      arrow.className = 'colamd-menu-arrow'
      arrow.textContent = '›'
      row.appendChild(arrow)
      // 二级条目可能是异步取的（最近打开）：取到后缓存，再次悬停即时展开
      let cached: MenuItem[] | null = null
      row.addEventListener('mouseenter', () => {
        closeFlyoutsFrom(depth)
        const flyout = document.createElement('div')
        flyout.className = 'colamd-menu colamd-menu-flyout'
        document.body.appendChild(flyout)
        const place = (items: MenuItem[]): void => {
          renderEntries(flyout, items, depth + 1)
          placeFlyout(flyout, row)
        }
        if (cached) place(cached)
        else {
          const resolved = entry.items!()
          if (Array.isArray(resolved)) place((cached = resolved))
          else void resolved.then((items) => place((cached = items)), () => flyout.remove())
        }
        flyouts.push(flyout)
      })
    } else {
      if (entry.hint) {
        const hint = document.createElement('span')
        hint.className = entry.hintIsPath ? 'colamd-menu-hint colamd-menu-hint-path' : 'colamd-menu-hint'
        hint.textContent = entry.hint
        row.appendChild(hint)
      }
      row.addEventListener('click', () => fire(entry))
      row.addEventListener('mouseenter', () => closeFlyoutsFrom(depth))
    }
    container.appendChild(row)
  }
}

function placeFlyout(flyout: HTMLElement, row: HTMLElement): void {
  const rowRect = row.getBoundingClientRect()
  const flyRect = flyout.getBoundingClientRect()
  const left = rowRect.right + 4 + flyRect.width > window.innerWidth - 8
    ? Math.max(8, rowRect.left - flyRect.width - 4)
    : rowRect.right + 4
  flyout.style.left = `${left}px`
  flyout.style.top = `${Math.max(8, Math.min(rowRect.top - 6, window.innerHeight - flyRect.height - 8))}px`
}

/** 打开某个模块的面板（已开着就收起）。 */
export function toggleAppMenu(module?: MenuModule): void {
  const target = module ?? 'file'
  if (openModule === target) {
    closeMenu()
    return
  }
  closeMenu()
  const button = moduleButton(target)
  if (!button) return
  const zh = isChinese()
  const next = document.createElement('div')
  next.className = 'colamd-menu colamd-menu-panel'
  next.setAttribute('role', 'menu')
  renderEntries(next, moduleEntries(target, zh), 0)
  document.body.appendChild(next)
  const buttonRect = button.getBoundingClientRect()
  const panelRect = next.getBoundingClientRect()
  next.style.left = `${Math.max(8, Math.min(buttonRect.left, window.innerWidth - panelRect.width - 8))}px`
  next.style.top = `${buttonRect.bottom + 6}px`
  panel = next
  openModule = target
  button.classList.add('active')

  dismissOnDocDown = (event: MouseEvent): void => {
    const point = event.target as Node
    if (panel?.contains(point) || flyouts.some((flyout) => flyout.contains(point))) return
    if (MENU_MODULES.some((entry) => moduleButton(entry.id)?.contains(point))) return
    closeMenu()
  }
  // 菜单与原生菜单一样不夺焦点：按钮被按下时拦掉默认的聚焦行为，编辑器保持焦点，
  // 选区不丢，「选中一段 → 点加粗」才成立（格式命令带 hasFocus 守卫）
  keepFocus = (event: MouseEvent): void => {
    const point = event.target as Node
    if (panel?.contains(point) || flyouts.some((flyout) => flyout.contains(point))
      || MENU_MODULES.some((entry) => moduleButton(entry.id)?.contains(point))) {
      event.preventDefault()
    }
  }
  dismissOnKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeMenu()
  }
  dismissOnBlur = (): void => closeMenu()
  document.addEventListener('mousedown', dismissOnDocDown, true)
  document.addEventListener('mousedown', keepFocus, true)
  document.addEventListener('keydown', dismissOnKey, true)
  window.addEventListener('blur', dismissOnBlur)
}

/** 外壳接线：给每个模块按钮挂点击与悬停切换。 */
export function bindModuleButtons(): void {
  for (const entry of MENU_MODULES) {
    const button = moduleButton(entry.id)
    if (!button) continue
    button.addEventListener('click', () => toggleAppMenu(entry.id))
    button.addEventListener('mouseenter', () => {
      // 菜单栏手感：面板开着时划过另一个模块按钮，直接换到那一栏
      if (openModule && openModule !== entry.id) toggleAppMenu(entry.id)
    })
  }
}
