// ColaMD CT：偏好设置弹窗。
//
// 完整版：左侧分栏导航（编辑器 / Markdown / 图片 / 表格 / 快捷键），
// 右侧是当前分区的表单。两类保存语义——
//   即时生效：Markdown 方言、表格、编辑器里的视图项（改一下立刻看得见，
//             经 settings:update → 主进程广播 settings:changed → 应用）
//   显式保存：图床凭据与快捷键改绑（敲到一半不能半截生效），底部 保存/取消。
// 骨架沿用编辑器字体弹窗（font-settings.ts）的 math-modal 体系，配色全部走主题变量。

import {
  EDITOR_COMMANDS, acceleratorFromEvent, canonicalKey, displayAccelerator, isValidAccelerator, mergeAccelerators,
  type EditorCommandSpec,
} from '../shared/commands'
import type { AppSettings, ImageSettings, MarkdownDialectSettings, TableSettings } from '../shared/settings-types'
import { applyKeybindings } from './editor/keymap-config'
import { isChinese } from './ui-language'

type Section = 'editor' | 'markdown' | 'image' | 'table' | 'keys'

export async function showPreferences(): Promise<void> {
  const settings = await window.electronAPI?.getSettings()
  if (!settings) return

  // 显式保存的工作副本：图床 + 快捷键（改绑）
  const image: ImageSettings = structuredClone(settings.image)
  const overrides = new Map<string, string>(Object.entries(structuredClone(settings.keybindings)))
  // 即时生效工作副本：方言 + 表格（toggle 一下就 settings:update）
  const markdown: MarkdownDialectSettings = { ...settings.markdown }
  const table: TableSettings = { ...settings.table }
  let active: Section = 'editor'

  const zh = isChinese()
  const t = {
    title: zh ? '偏好设置' : 'Preferences',
    sections: {
      editor: zh ? '编辑器' : 'Editor',
      markdown: 'Markdown',
      image: zh ? '图片' : 'Images',
      table: zh ? '表格' : 'Tables',
      keys: zh ? '快捷键' : 'Shortcuts',
    },
    // 编辑器
    language: zh ? '界面语言' : 'Language',
    panelSide: zh ? '文件面板位置' : 'File panel position',
    left: zh ? '左侧' : 'Left',
    right: zh ? '右侧' : 'Right',
    pageWidth: zh ? '正文宽度' : 'Text width',
    narrow: zh ? '窄' : 'Narrow',
    standard: zh ? '标准' : 'Standard',
    wide: zh ? '宽' : 'Wide',
    // 启动行为（v2.7.25 三选项）
    startupMode: zh ? '启动时' : 'On launch',
    startupBlank: zh ? '新建文件' : 'New blank file',
    startupRestore: zh ? '打开上次会话的所有文件' : 'Reopen tabs from last session',
    startupWelcome: zh ? '显示欢迎界面' : 'Show welcome screen',
    viewHint: zh ? '视图类设置即时生效' : 'View settings apply instantly',
    // Markdown
    looseEmphasis: zh ? '宽松强调（中文标点友好）' : 'Loose emphasis (CJK punctuation)',
    looseHint: zh ? '严格 CommonMark 会把 `**加粗**。`、`（**粗**）` 判成普通文字（全角标点挡住闭合）。开启后补画这类被拒掉的加粗、斜体、删除线；空格侧仍从严。' : 'Strict CommonMark rejects emphasis adjacent to punctuation. On = render it anyway.',
    inlineMath: zh ? '行内公式 $…$' : 'Inline math $…$',
    inlineMathHint: zh ? '关闭后 `$` 是普通字符；块级 `$$…$$` 不受影响。' : 'Off = literal `$`; block `$$…$$` unaffected.',
    highlight: zh ? '高亮 ==文字==' : 'Highlight ==text==',
    markdownHint: zh ? '改动即时生效并写入本机设置' : 'Applies instantly and is saved locally',
    // 图片（沿用原文案）
    behavior: zh ? '插入图片时（粘贴 / 拖拽）' : 'When inserting images (paste / drop)',
    ask: zh ? '每次询问' : 'Ask every time',
    upload: zh ? '上传到图床' : 'Upload to image host',
    copy: zh ? '复制到文档目录' : 'Copy to document folder',
    reference: zh ? '保留原路径' : 'Keep original path',
    provider: zh ? '图床服务' : 'Image host',
    copyDir: zh ? '复制目录（相对文档）' : 'Copy folder (relative to doc)',
    namePattern: zh ? '文件名模板' : 'File name pattern',
    patternHint: zh ? '可用变量：{name} 原名 · {hash} 内容哈希 · {date} 日期' : 'Variables: {name} · {hash} · {date}',
    picgoUrl: 'PicGo Server URL',
    githubToken: 'GitHub Token',
    githubOwner: 'GitHub Owner',
    githubRepo: 'GitHub Repo',
    githubBranch: zh ? '分支' : 'Branch',
    githubPath: zh ? '仓库内目录' : 'Repo folder',
    jsDelivr: zh ? '改用 jsDelivr CDN（仓库须公开）' : 'Use jsDelivr CDN (public repo)',
    smmsToken: 'SM.MS API Token',
    customUrl: zh ? '上传地址' : 'Upload URL',
    customField: zh ? '文件字段名' : 'File field name',
    customHeaders: zh ? '额外请求头（JSON）' : 'Extra headers (JSON)',
    customRespPath: zh ? '响应 URL 路径（如 data.url，留空自动猜）' : 'Response URL path (e.g. data.url; empty = auto)',
    imageHint: zh ? '「上传」用到的服务；凭据只存本机' : 'Used by Upload; credentials stay local',
    // 表格
    rememberWidths: zh ? '记住表格列宽' : 'Remember table column widths',
    widthsHint: zh ? '列宽按文档存放在本机（不写进 md 文件）。关闭后列宽不再随文档恢复。' : 'Stored locally per document, never inside the .md file.',
    tableHint: zh ? '改动即时生效' : 'Applies instantly',
    // 快捷键
    keysHint: zh ? '点击按键重新绑定；Backspace 解绑；Esc 取消' : 'Click a binding to rebind; Backspace unbinds; Esc cancels',
    unbound: zh ? '未绑定' : 'none',
    resetAll: zh ? '全部恢复默认' : 'Reset all',
    cancel: zh ? '取消' : 'Cancel',
    save: zh ? '保存图片与快捷键' : 'Save images & shortcuts',
  }

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay'
  const modal = document.createElement('div')
  modal.className = 'math-modal colamd-pref-modal colamd-pref-full'

  const header = document.createElement('h3')
  header.textContent = t.title

  // ── 布局：侧边导航 + 内容区 ──
  const layout = document.createElement('div')
  layout.className = 'colamd-pref-layout'
  const nav = document.createElement('nav')
  nav.className = 'colamd-pref-nav'
  const content = document.createElement('div')
  content.className = 'colamd-pref-content'

  const panes: Record<Section, HTMLDivElement> = {
    editor: document.createElement('div'),
    markdown: document.createElement('div'),
    image: document.createElement('div'),
    table: document.createElement('div'),
    keys: document.createElement('div'),
  }
  for (const [key, pane] of Object.entries(panes)) {
    pane.className = 'colamd-pref-pane'
    content.appendChild(pane)
  }

  const navButtons = new Map<Section, HTMLButtonElement>()
  for (const key of ['editor', 'markdown', 'image', 'table', 'keys'] as Section[]) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'colamd-pref-nav-item'
    item.textContent = t.sections[key]
    item.addEventListener('click', () => activate(key))
    nav.appendChild(item)
    navButtons.set(key, item)
  }
  function activate(section: Section): void {
    active = section
    for (const [key, pane] of Object.entries(panes)) {
      pane.style.display = key === section ? 'flex' : 'none'
    }
    navButtons.forEach((button, key) => button.classList.toggle('active', key === section))
  }

  layout.append(nav, content)

  // ── 通用小部件 ──
  const sectionCard = (parent: HTMLElement, title: string, hint?: string): HTMLDivElement => {
    const card = document.createElement('div')
    card.className = 'colamd-pref-section'
    const head = document.createElement('div')
    head.className = 'colamd-pref-section-title'
    head.textContent = title
    card.appendChild(head)
    if (hint) {
      const hintEl = document.createElement('div')
      hintEl.className = 'colamd-pref-hint'
      hintEl.textContent = hint
      card.appendChild(hintEl)
    }
    const body = document.createElement('div')
    body.className = 'colamd-pref-section-body'
    card.appendChild(body)
    parent.appendChild(card)
    return body
  }
  const rowOf = (parent: HTMLElement, label: string): HTMLDivElement => {
    const wrap = document.createElement('div')
    wrap.className = 'colamd-pref-row'
    const lab = document.createElement('label')
    lab.textContent = label
    wrap.append(lab)
    parent.appendChild(wrap)
    return wrap
  }
  const inputOf = (value: string, placeholder = '', type = 'text'): HTMLInputElement => {
    const el = document.createElement('input')
    el.className = 'colamd-pref-input'
    el.type = type
    el.value = value
    el.placeholder = placeholder
    el.autocomplete = 'off'
    return el
  }
  const selectOf = (options: [string, string][], value: string): HTMLSelectElement => {
    const el = document.createElement('select')
    el.className = 'colamd-pref-select'
    for (const [v, label] of options) {
      const option = document.createElement('option')
      option.value = v
      option.textContent = label
      el.appendChild(option)
    }
    el.value = value
    return el
  }
  /** 开关行：点击即刻 settings:update（主进程广播回来由外壳应用）。 */
  const toggleOf = (parent: HTMLElement, label: string, hint: string, value: boolean, onChange: (next: boolean) => void): void => {
    const row = document.createElement('div')
    row.className = 'colamd-pref-toggle'
    const text = document.createElement('div')
    text.className = 'colamd-pref-toggle-text'
    const name = document.createElement('div')
    name.className = 'colamd-pref-toggle-name'
    name.textContent = label
    const hintEl = document.createElement('div')
    hintEl.className = 'colamd-pref-hint'
    hintEl.textContent = hint
    text.append(name, hintEl)
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = value
    box.className = 'colamd-pref-switch'
    box.addEventListener('change', () => onChange(box.checked))
    row.append(text, box)
    parent.appendChild(row)
  }

  // ════════ 分区一：编辑器（视图类，即时生效） ════════
  {
    const body = sectionCard(panes.editor, t.sections.editor, t.viewHint)
    const langRow = rowOf(body, t.language)
    const langSel = selectOf([['zh', '中文'], ['en', 'English']], isChinese() ? 'zh' : 'en')
    langSel.addEventListener('change', () => void window.electronAPI?.setLanguage(langSel.value as 'zh' | 'en'))
    langRow.appendChild(langSel)

    const sideRow = rowOf(body, t.panelSide)
    const sideSel = selectOf([['right', t.right], ['left', t.left]], localStorage.getItem('colamd-panel-side') || 'right')
    sideSel.addEventListener('change', () => void window.electronAPI?.appMenuAction('set-panel-side', sideSel.value))
    sideRow.appendChild(sideSel)

    const widthRow = rowOf(body, t.pageWidth)
    const widthSel = selectOf([['narrow', t.narrow], ['standard', t.standard], ['wide', t.wide]], localStorage.getItem('colamd-page-width') || 'standard')
    widthSel.addEventListener('change', () => void window.electronAPI?.appMenuAction('set-page-width', widthSel.value))
    widthRow.appendChild(widthSel)

    // 启动行为三选项（v2.7.25）：新建文件 / 打开上次会话的所有文件 / 显示欢迎界面，
    // 即时生效（走 set-startup-mode，住 recent.json）。老的布尔开关就此退役。
    const startupBody = sectionCard(panes.editor, zh ? '启动' : 'Startup')
    const startupRow = rowOf(startupBody, t.startupMode)
    const mountStartupSelect = (mode: string): void => {
      const startupSel = selectOf([
        ['blank', t.startupBlank],
        ['restore', t.startupRestore],
        ['welcome', t.startupWelcome],
      ], mode)
      startupSel.addEventListener('change', () => {
        void window.electronAPI?.setStartupMode(startupSel.value as 'blank' | 'restore' | 'welcome')
      })
      startupRow.appendChild(startupSel)
    }
    const mode = await window.electronAPI?.getStartupMode()
    mountStartupSelect(mode ?? 'blank')
  }

  // ════════ 分区二：Markdown 方言（即时生效） ════════
  {
    const body = sectionCard(panes.markdown, t.sections.markdown, t.markdownHint)
    const persist = () => void window.electronAPI?.updateSettings({ markdown: { ...markdown } })
    toggleOf(body, t.looseEmphasis, t.looseHint, markdown.looseEmphasis, (next) => { markdown.looseEmphasis = next; persist() })
    toggleOf(body, t.inlineMath, t.inlineMathHint, markdown.inlineMath, (next) => { markdown.inlineMath = next; persist() })
    toggleOf(body, t.highlight, '', markdown.highlight, (next) => { markdown.highlight = next; persist() })
  }

  // ════════ 分区三：图片（显式保存） ════════
  const providerFields = document.createElement('div')
  {
    const behaviorBody = sectionCard(panes.image, t.behavior)
    const behaviorRow = rowOf(behaviorBody, t.behavior)
    const behaviorSel = selectOf(
      [['ask', t.ask], ['upload', t.upload], ['copy', t.copy], ['reference', t.reference]] as [string, string][],
      image.insertBehavior,
    )
    behaviorSel.addEventListener('change', () => { image.insertBehavior = behaviorSel.value as ImageSettings['insertBehavior'] })
    behaviorRow.appendChild(behaviorSel)

    const providerBody = sectionCard(panes.image, t.sections.image, t.imageHint)
    const providerRow = rowOf(providerBody, t.provider)
    const providerSel = selectOf(
      [['picgo', 'PicGo'], ['github', 'GitHub'], ['smms', 'SM.MS'], ['custom', zh ? '自定义' : 'Custom']] as [string, string][],
      image.uploadProvider,
    )
    providerSel.addEventListener('change', () => { image.uploadProvider = providerSel.value as ImageSettings['uploadProvider']; renderProviderFields() })
    providerRow.appendChild(providerSel)
    providerFields.style.display = 'flex'
    providerFields.style.flexDirection = 'column'
    providerFields.style.gap = '12px'
    providerBody.appendChild(providerFields)

    function renderProviderFields(): void {
      providerFields.replaceChildren()
      const provider = image.uploadProvider
      if (provider === 'picgo') {
        const r = rowOf(providerFields, t.picgoUrl)
        const el = inputOf(image.picgo.url, 'http://127.0.0.1:36677/upload')
        el.addEventListener('input', () => { image.picgo.url = el.value })
        r.appendChild(el)
      } else if (provider === 'github') {
        const token = inputOf(image.github.token, 'ghp_… / github_pat_…', 'password')
        token.addEventListener('input', () => { image.github.token = token.value })
        const owner = inputOf(image.github.owner)
        owner.addEventListener('input', () => { image.github.owner = owner.value })
        const repo = inputOf(image.github.repo)
        repo.addEventListener('input', () => { image.github.repo = repo.value })
        const branch = inputOf(image.github.branch, 'main')
        branch.addEventListener('input', () => { image.github.branch = branch.value })
        const path = inputOf(image.github.path, 'images')
        path.addEventListener('input', () => { image.github.path = path.value })
        const cdnRow = document.createElement('label')
        cdnRow.className = 'colamd-pref-toggle'
        const cdnText = document.createElement('div')
        cdnText.className = 'colamd-pref-toggle-name'
        cdnText.textContent = t.jsDelivr
        const cdn = document.createElement('input')
        cdn.type = 'checkbox'
        cdn.className = 'colamd-pref-switch'
        cdn.checked = image.github.useJsDelivr
        cdn.addEventListener('change', () => { image.github.useJsDelivr = cdn.checked })
        cdnRow.append(cdnText, cdn)
        for (const [label, el] of [[t.githubToken, token], [t.githubOwner, owner], [t.githubRepo, repo], [t.githubBranch, branch], [t.githubPath, path]] as const) {
          rowOf(providerFields, label).appendChild(el)
        }
        providerFields.appendChild(cdnRow)
      } else if (provider === 'smms') {
        const r = rowOf(providerFields, t.smmsToken)
        const el = inputOf(image.smms.token, '', 'password')
        el.addEventListener('input', () => { image.smms.token = el.value })
        r.appendChild(el)
      } else {
        const url = inputOf(image.custom.url, 'https://…')
        url.addEventListener('input', () => { image.custom.url = url.value })
        const field = inputOf(image.custom.fieldName, 'image')
        field.addEventListener('input', () => { image.custom.fieldName = field.value })
        const headers = inputOf(JSON.stringify(image.custom.headers ?? {}), '{"Authorization": "…"}')
        headers.dataset.role = 'headers'
        const respPath = inputOf(image.custom.responsePath, 'data.url')
        respPath.addEventListener('input', () => { image.custom.responsePath = respPath.value })
        for (const [label, el] of [[t.customUrl, url], [t.customField, field], [t.customHeaders, headers], [t.customRespPath, respPath]] as const) {
          rowOf(providerFields, label).appendChild(el)
        }
      }
    }
    renderProviderFields()

    const localBody = sectionCard(panes.image, zh ? '本地副本与命名' : 'Local copies & naming')
    const copyDirRow = rowOf(localBody, t.copyDir)
    const copyDirInput = inputOf(image.copyDir, 'assets')
    copyDirInput.addEventListener('input', () => { image.copyDir = copyDirInput.value })
    copyDirRow.appendChild(copyDirInput)
    const patternRow = rowOf(localBody, t.namePattern)
    const patternInput = inputOf(image.namePattern, '{name}-{hash}')
    patternInput.addEventListener('input', () => { image.namePattern = patternInput.value })
    const patternHint = document.createElement('div')
    patternHint.className = 'colamd-pref-hint'
    patternHint.textContent = t.patternHint
    patternRow.append(patternInput, patternHint)
  }

  // ════════ 分区四：表格（即时生效） ════════
  {
    const body = sectionCard(panes.table, t.sections.table, t.tableHint)
    const persist = () => void window.electronAPI?.updateSettings({ table: { ...table } })
    toggleOf(body, t.rememberWidths, t.widthsHint, table.rememberWidths, (next) => { table.rememberWidths = next; persist() })
  }

  // ════════ 分区五：快捷键（显式保存） ════════
  {
    const body = sectionCard(panes.keys, t.sections.keys === 'Markdown' ? 'Shortcuts' : t.sections.keys, t.keysHint)
    const keysList = document.createElement('div')
    keysList.className = 'colamd-pref-keys'
    body.appendChild(keysList)

    const GROUP_LABELS: Record<string, string> = {
      inline: zh ? '行内格式' : 'Inline',
      heading: zh ? '标题' : 'Headings',
      list: zh ? '列表' : 'Lists',
      block: zh ? '块级' : 'Blocks',
      insert: zh ? '插入' : 'Insert',
    }
    const GROUP_ORDER = ['inline', 'heading', 'list', 'block', 'insert'] as const

    const bindingButtons = new Map<string, HTMLButtonElement>()
    let capturingId: string | null = null
    /** 「需含修饰键」提示的复原计时器。 */
    let captureHintTimer: ReturnType<typeof setTimeout> | null = null

    const effective = (): Record<string, string> => {
      const merged: Record<string, string> = {}
      for (const command of EDITOR_COMMANDS) merged[command.id] = command.accelerator
      for (const [id, value] of overrides) if (value !== undefined) merged[id] = value
      return merged
    }
    // 写给人看的写法与标题栏模块菜单同源（displayAccelerator）：两处看到的永远是同一个键；
    // macOS 上 CmdOrCtrl 写成 Cmd（darwin 位此前没人传，mac 一直显示 Ctrl）
    const isDarwin = /^Mac/i.test(navigator.platform)
    const displayOf = (command: EditorCommandSpec): string => {
      const value = overrides.has(command.id) ? overrides.get(command.id) as string : command.accelerator
      return value === '' ? t.unbound : displayAccelerator(value, isDarwin)
    }
    const markConflicts = (): void => {
      const current = effective()
      const seen = new Map<string, number>()
      for (const value of Object.values(current)) {
        if (!value) continue
        // 按归一后的键比（`Shift+Alt+C` 与 `Alt+Shift+C`、`Ctrl+Shift+^` 与 `Ctrl+Shift+6` 是同一个键）
        const key = canonicalKey(value)
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
      for (const [id, button] of bindingButtons) {
        button.classList.toggle('conflict', !!current[id] && (seen.get(canonicalKey(current[id])) ?? 0) > 1)
        button.classList.toggle('capturing', capturingId === id)
      }
    }

    const renderKeys = (): void => {
      keysList.replaceChildren()
      bindingButtons.clear()
      for (const group of GROUP_ORDER) {
        const groupLabel = document.createElement('div')
        groupLabel.className = 'colamd-pref-key-group'
        groupLabel.textContent = GROUP_LABELS[group]
        keysList.appendChild(groupLabel)
        for (const command of EDITOR_COMMANDS) {
          if (command.group !== group) continue
          const keyRow = document.createElement('div')
          keyRow.className = 'colamd-pref-key-row'
          const name = document.createElement('span')
          name.className = 'colamd-pref-key-name'
          name.textContent = zh ? command.zh : command.en
          const binding = document.createElement('button')
          binding.className = 'colamd-pref-key-binding'
          binding.textContent = displayOf(command)
          binding.addEventListener('click', () => {
            capturingId = command.id
            binding.textContent = zh ? '按下新组合…' : 'Press keys…'
            markConflicts()
          })
          bindingButtons.set(command.id, binding)
          const reset = document.createElement('button')
          reset.className = 'colamd-pref-key-reset'
          reset.textContent = '↺'
          reset.title = zh ? '恢复默认' : 'Reset'
          reset.addEventListener('click', () => {
            overrides.delete(command.id)
            binding.textContent = displayOf(command)
            markConflicts()
          })
          keyRow.append(name, binding, reset)
          keysList.appendChild(keyRow)
        }
      }
      markConflicts()
    }

    // 捕获键在 modal 上监听；先按下的修饰键不是组合本身，等真正的键位到达再判定
    modal.addEventListener('keydown', (event) => {
      if (!capturingId) return
      if (['Alt', 'Control', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const button = bindingButtons.get(capturingId)
      const id = capturingId
      capturingId = null
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        event.stopPropagation()
        overrides.set(id, '')
      } else {
        // 完整的组合键（修饰键 + 物理键），与按键层匹配用的形式同源（shared/commands）
        const accelerator = acceleratorFromEvent(event)
        if (!accelerator || !isValidAccelerator(accelerator)) {
          event.preventDefault()
          event.stopPropagation()
          // 这次没按对：提示一下，继续等下一个组合。以前这里直接结束捕获，按钮上就一直
          // 留着那句提示，原来的键位也看不见了。
          capturingId = id
          if (button) {
            button.textContent = zh ? '需含 Ctrl/Cmd 或 Alt 修饰' : 'Needs Ctrl/Cmd or Alt'
            if (captureHintTimer) clearTimeout(captureHintTimer)
            captureHintTimer = setTimeout(() => {
              captureHintTimer = null
              if (capturingId === id && button.isConnected) button.textContent = zh ? '按下新组合…' : 'Press keys…'
            }, 1200)
          }
          markConflicts()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        overrides.set(id, accelerator)
      }
      if (button) button.textContent = displayOf(EDITOR_COMMANDS.find((command) => command.id === id) as EditorCommandSpec)
      markConflicts()
    })
    renderKeys()

    const resetAll = document.createElement('button')
    resetAll.type = 'button'
    resetAll.className = 'math-modal-btn cancel'
    resetAll.textContent = t.resetAll
    resetAll.style.alignSelf = 'flex-start'
    resetAll.addEventListener('click', () => {
      overrides.clear()
      renderKeys()
    })
    panes.keys.appendChild(resetAll)
  }

  // ── 底部：保存（图床字段 + 快捷键）与取消 ──
  const footer = document.createElement('div')
  footer.className = 'colamd-pref-footer'
  const note = document.createElement('span')
  note.className = 'colamd-pref-hint'
  note.textContent = zh ? '方言 / 表格 / 视图项已即时保存；此处保存图床与快捷键' : 'Dialect & view applied instantly; this saves images & shortcuts'
  const footerRight = document.createElement('div')
  footerRight.className = 'math-modal-footer'
  const cancel = document.createElement('button')
  cancel.className = 'math-modal-btn cancel'
  cancel.textContent = t.cancel
  cancel.addEventListener('click', () => overlay.remove())
  const save = document.createElement('button')
  save.className = 'math-modal-btn save'
  save.textContent = t.save
  save.addEventListener('click', () => {
    const headersInput = providerFields.querySelector<HTMLInputElement>('input[data-role="headers"]')
    if (headersInput) {
      try {
        image.custom.headers = JSON.parse(headersInput.value || '{}')
      } catch {
        image.custom.headers = settings.image.custom.headers
      }
    }
    const keybindings: Record<string, string> = {}
    for (const command of EDITOR_COMMANDS) {
      if (!overrides.has(command.id)) continue
      const value = overrides.get(command.id) as string
      if (value === command.accelerator) continue
      keybindings[command.id] = value
    }
    overlay.remove()
    void window.electronAPI?.updateSettings({ image, keybindings }).then((next) => {
      // 与按键层的启动路径同一个合并函数（带合法性校验），主进程重搭原生菜单用的也是这一份
      applyKeybindings(mergeAccelerators(next.keybindings))
    })
  })
  footerRight.append(cancel, save)
  footer.append(note, footerRight)

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) overlay.remove()
  })

  activate('editor')
  modal.append(header, layout, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}
