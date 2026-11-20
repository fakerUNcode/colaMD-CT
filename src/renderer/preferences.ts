// ColaMD CT：偏好设置弹窗（图片 / 快捷键 两页签）。
//
// 结构沿用编辑器字体弹窗（font-settings.ts）的 math-modal 骨架：DOM 拼装、
// 不引框架。保存 = 一次 settings:update 局部合并，主进程落盘、重建菜单、
// 广播 settings:changed；本窗口的键盘映射立即热更新，别的窗口靠广播跟进。

import { EDITOR_COMMANDS, isValidAccelerator, type EditorCommandSpec } from '../shared/commands'
import type { AppSettings, ImageSettings } from '../shared/settings-types'
import { applyKeybindings } from './editor/keymap-config'
import { isChinese } from './ui-language'

type Tab = 'image' | 'keys'

export async function showPreferences(): Promise<void> {
  const settings = await window.electronAPI?.getSettings()
  if (!settings) return

  // 工作副本：取消 = 全部丢弃；快捷键页只存「与默认不同的覆盖」
  const image: ImageSettings = structuredClone(settings.image)
  const overrides = new Map<string, string>(Object.entries(structuredClone(settings.keybindings)))
  let activeTab: Tab = 'image'

  const zh = isChinese()
  const t = {
    title: zh ? '偏好设置' : 'Preferences',
    tabImage: zh ? '图片' : 'Images',
    tabKeys: zh ? '快捷键' : 'Shortcuts',
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
    keysHint: zh ? '点击按键重新绑定；Backspace 解绑；Esc 取消' : 'Click a binding to rebind; Backspace unbinds; Esc cancels',
    conflict: zh ? '冲突' : 'conflict',
    unbound: zh ? '未绑定' : 'none',
    resetAll: zh ? '全部恢复默认' : 'Reset all',
    cancel: zh ? '取消' : 'Cancel',
    save: zh ? '保存' : 'Save',
  }

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay'
  const modal = document.createElement('div')
  modal.className = 'math-modal colamd-pref-modal'

  const header = document.createElement('h3')
  header.textContent = t.title

  const tabs = document.createElement('div')
  tabs.className = 'colamd-pref-tabs'
  const tabImage = document.createElement('button')
  tabImage.className = 'colamd-pref-tab'
  tabImage.textContent = t.tabImage
  const tabKeys = document.createElement('button')
  tabKeys.className = 'colamd-pref-tab'
  tabKeys.textContent = t.tabKeys
  tabs.append(tabImage, tabKeys)

  const body = document.createElement('div')
  body.className = 'colamd-pref-body'

  // ─── 图片页 ────────────────────────────────────────────────────────────────

  const imagePage = document.createElement('div')
  imagePage.style.display = 'flex'
  imagePage.style.flexDirection = 'column'
  imagePage.style.gap = '12px'

  /** 功能分区标题：把一长溜表单切成「行为 → 图床 → 本地副本」三块。 */
  const section = (title: string, hint?: string): HTMLDivElement => {
    const wrap = document.createElement('div')
    wrap.className = 'colamd-pref-section'
    const head = document.createElement('div')
    head.className = 'colamd-pref-section-title'
    head.textContent = title
    wrap.appendChild(head)
    if (hint) {
      const hintEl = document.createElement('div')
      hintEl.className = 'colamd-pref-hint'
      hintEl.textContent = hint
      wrap.appendChild(hintEl)
    }
    const body = document.createElement('div')
    body.className = 'colamd-pref-section-body'
    wrap.appendChild(body)
    imagePage.appendChild(wrap)
    return body
  }
  const row = (label: string): { wrap: HTMLDivElement; content: HTMLDivElement } => {
    const wrap = document.createElement('div')
    wrap.className = 'colamd-pref-row'
    const lab = document.createElement('label')
    lab.textContent = label
    wrap.append(lab)
    const content = document.createElement('div')
    wrap.appendChild(content)
    return { wrap, content }
  }
  const input = (value: string, placeholder = '', type = 'text'): HTMLInputElement => {
    const el = document.createElement('input')
    el.className = 'colamd-pref-input'
    el.type = type
    el.value = value
    el.placeholder = placeholder
    el.autocomplete = 'off'
    return el
  }

  // ── 分区一：插入行为 ──
  const behaviorSection = section(zh ? '插入行为' : 'Insert behavior', zh ? '粘贴 / 拖入图片时怎么处理' : 'What happens on paste / drop')
  const behaviorRow = row(t.behavior)
  const behaviorSelect = document.createElement('select')
  behaviorSelect.className = 'colamd-pref-select'
  for (const [value, label] of [['ask', t.ask], ['upload', t.upload], ['copy', t.copy], ['reference', t.reference]] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    behaviorSelect.appendChild(option)
  }
  behaviorSelect.value = image.insertBehavior
  behaviorSelect.addEventListener('change', () => { image.insertBehavior = behaviorSelect.value as ImageSettings['insertBehavior'] })
  behaviorRow.content.appendChild(behaviorSelect)
  behaviorSection.appendChild(behaviorRow.wrap)

  // ── 分区二：图床服务（仅「上传」行为用到）──
  const providerSection = section(zh ? '图床服务' : 'Image host', zh ? '「上传到图床」用哪个服务；凭据只存本机' : 'Used by Upload; credentials stay local')
  const providerRow = row(t.provider)
  const providerSelect = document.createElement('select')
  providerSelect.className = 'colamd-pref-select'
  for (const [value, label] of [['picgo', 'PicGo'], ['github', 'GitHub'], ['smms', 'SM.MS'], ['custom', zh ? '自定义' : 'Custom']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    providerSelect.appendChild(option)
  }
  providerSelect.value = image.uploadProvider
  providerSelect.addEventListener('change', () => { image.uploadProvider = providerSelect.value as ImageSettings['uploadProvider']; renderProviderFields() })
  providerRow.content.appendChild(providerSelect)
  providerSection.appendChild(providerRow.wrap)
  const providerFields = document.createElement('div')
  providerFields.style.display = 'flex'
  providerFields.style.flexDirection = 'column'
  providerFields.style.gap = '12px'
  providerSection.appendChild(providerFields)

  function renderProviderFields(): void {
    providerFields.replaceChildren()
    const provider = image.uploadProvider
    if (provider === 'picgo') {
      const r = row(t.picgoUrl)
      const el = input(image.picgo.url, 'http://127.0.0.1:36677/upload')
      el.addEventListener('input', () => { image.picgo.url = el.value })
      r.content.appendChild(el)
      providerFields.appendChild(r.wrap)
    } else if (provider === 'github') {
      const token = input(image.github.token, 'ghp_… / github_pat_…', 'password')
      token.addEventListener('input', () => { image.github.token = token.value })
      const owner = input(image.github.owner)
      owner.addEventListener('input', () => { image.github.owner = owner.value })
      const repo = input(image.github.repo)
      repo.addEventListener('input', () => { image.github.repo = repo.value })
      const branch = input(image.github.branch, 'main')
      branch.addEventListener('input', () => { image.github.branch = branch.value })
      const path = input(image.github.path, 'images')
      path.addEventListener('input', () => { image.github.path = path.value })
      const cdnRow = document.createElement('label')
      cdnRow.className = 'colamd-pref-remember'
      const cdn = document.createElement('input')
      cdn.type = 'checkbox'
      cdn.checked = image.github.useJsDelivr
      cdn.addEventListener('change', () => { image.github.useJsDelivr = cdn.checked })
      cdnRow.append(cdn, document.createTextNode(t.jsDelivr))
      for (const [label, el] of [[t.githubToken, token], [t.githubOwner, owner], [t.githubRepo, repo], [t.githubBranch, branch], [t.githubPath, path]] as const) {
        const r = row(label)
        r.content.appendChild(el)
        providerFields.appendChild(r.wrap)
      }
      providerFields.appendChild(cdnRow)
    } else if (provider === 'smms') {
      const r = row(t.smmsToken)
      const el = input(image.smms.token, '', 'password')
      el.addEventListener('input', () => { image.smms.token = el.value })
      r.content.appendChild(el)
      providerFields.appendChild(r.wrap)
    } else {
      const url = input(image.custom.url, 'https://…')
      url.addEventListener('input', () => { image.custom.url = url.value })
      const field = input(image.custom.fieldName, 'image')
      field.addEventListener('input', () => { image.custom.fieldName = field.value })
      const headers = input(JSON.stringify(image.custom.headers ?? {}), '{"Authorization": "…"}')
      headers.dataset.role = 'headers'
      const respPath = input(image.custom.responsePath, 'data.url')
      respPath.addEventListener('input', () => { image.custom.responsePath = respPath.value })
      for (const [label, el] of [[t.customUrl, url], [t.customField, field], [t.customHeaders, headers], [t.customRespPath, respPath]] as const) {
        const r = row(label)
        r.content.appendChild(el)
        providerFields.appendChild(r.wrap)
      }
    }
  }
  renderProviderFields()

  // ── 分区三：本地副本与命名 ──
  const localSection = section(zh ? '本地副本与命名' : 'Local copies & naming', zh ? '「复制到文档目录」和「上传失败降级」的落盘规则' : 'Where Copy-to-folder and upload fallback write files')
  const copyDirRow = row(t.copyDir)
  const copyDirInput = input(image.copyDir, 'assets')
  copyDirInput.addEventListener('input', () => { image.copyDir = copyDirInput.value })
  copyDirRow.content.appendChild(copyDirInput)
  localSection.appendChild(copyDirRow.wrap)

  const patternRow = row(t.namePattern)
  const patternInput = input(image.namePattern, '{name}-{hash}')
  patternInput.addEventListener('input', () => { image.namePattern = patternInput.value })
  const patternHint = document.createElement('div')
  patternHint.className = 'colamd-pref-hint'
  patternHint.textContent = t.patternHint
  patternRow.content.append(patternInput, patternHint)
  localSection.appendChild(patternRow.wrap)

  // ─── 快捷键页 ──────────────────────────────────────────────────────────────

  const keysPage = document.createElement('div')
  keysPage.style.display = 'none'
  keysPage.style.flexDirection = 'column'
  const keysHint = document.createElement('div')
  keysHint.className = 'colamd-pref-hint'
  keysHint.textContent = t.keysHint
  const keysList = document.createElement('div')
  keysList.className = 'colamd-pref-keys'
  keysPage.append(keysHint, keysList)

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

  const effective = (): Record<string, string> => {
    const merged: Record<string, string> = {}
    for (const command of EDITOR_COMMANDS) {
      merged[command.id] = overrides.has(command.id) ? (overrides.get(command.id) as string) : command.accelerator
    }
    return merged
  }

  function displayOf(command: EditorCommandSpec): string {
    const value = overrides.has(command.id) ? overrides.get(command.id) as string : command.accelerator
    return value === '' ? t.unbound : value
    // 展示用 accelerator 原文；平台化显示（⌘/Ctrl）交给 accelerator 本身（CmdOrCtrl）
  }

  function markConflicts(): void {
    const current = effective()
    const seen = new Map<string, number>()
    for (const value of Object.values(current)) {
      if (!value) continue
      seen.set(value, (seen.get(value) ?? 0) + 1)
    }
    for (const [id, button] of bindingButtons) {
      const value = current[id] ?? ''
      button.classList.toggle('conflict', !!value && (seen.get(value) ?? 0) > 1)
      button.classList.toggle('capturing', capturingId === id)
    }
  }

  function acceleratorFromEvent(event: KeyboardEvent): string | null {
    const hasCtrl = event.ctrlKey || event.metaKey
    const hasAlt = event.altKey
    if (!hasCtrl && !hasAlt) return null
    const key = physicalKey(event)
    if (!key) return null
    const mods: string[] = []
    if (hasCtrl) mods.push('CmdOrCtrl')
    if (event.shiftKey) mods.push('Shift')
    if (hasAlt) mods.push('Alt')
    return [...mods, key.toUpperCase()].join('+')
  }

  function physicalKey(event: KeyboardEvent): string | null {
    const code = event.code
    if (/^Key[A-Z]$/.test(code)) return code.slice(3)
    if (/^Digit\d$/.test(code)) return code.slice(5)
    const named: Record<string, string> = {
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backquote: '`',
      Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
    }
    if (code in named) return named[code]
    if (/^F\d{1,2}$/.test(code)) return code
    return event.key.length === 1 ? event.key : null
  }

  function renderKeys(): void {
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

  modal.addEventListener('keydown', (event) => {
    if (!capturingId) return
    // 先按下的修饰键（Alt、Ctrl…）不是组合本身：等真正的键位到达再判定，
    // 否则 Alt+1 会在 Alt 落下那一刻就被判「不支持的组合」并结束捕获。
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
      overrides.set(id, '') // 解绑
    } else {
      const accelerator = acceleratorFromEvent(event)
      if (!accelerator || !isValidAccelerator(accelerator)) {
        if (button) button.textContent = zh ? '需含 Ctrl/Cmd 或 Alt 修饰' : 'Needs Ctrl/Cmd or Alt'
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

  // ─── 页签切换 + 底部按钮 ───────────────────────────────────────────────────

  function activate(tab: Tab): void {
    activeTab = tab
    tabImage.classList.toggle('active', tab === 'image')
    tabKeys.classList.toggle('active', tab === 'keys')
    imagePage.style.display = tab === 'image' ? 'flex' : 'none'
    keysPage.style.display = tab === 'keys' ? 'flex' : 'none'
  }
  tabImage.addEventListener('click', () => activate('image'))
  tabKeys.addEventListener('click', () => activate('keys'))
  activate('image')

  const footer = document.createElement('div')
  footer.className = 'colamd-pref-footer'
  const resetAll = document.createElement('button')
  resetAll.className = 'math-modal-btn cancel'
  resetAll.textContent = t.resetAll
  resetAll.addEventListener('click', () => {
    overrides.clear()
    renderKeys()
  })
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
    // 自定义图床的 headers 是一段 JSON 文本，解析失败就原样放弃（不改旧值）
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
      if (value === command.accelerator) continue // 与默认相同就不存
      keybindings[command.id] = value
    }
    overlay.remove()
    void window.electronAPI?.updateSettings({ image, keybindings }).then((next) => {
      // 本窗口立即生效；别的窗口由主进程的 settings:changed 广播跟进
      applyKeybindings(mergedOf(next))
    })
  })
  footerRight.append(cancel, save)
  footer.append(resetAll, footerRight)

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) overlay.remove()
  })

  body.append(imagePage, keysPage)
  modal.append(header, tabs, body, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}

function mergedOf(settings: AppSettings | undefined | void): Record<string, string> {
  // 与 keymap-config 的 mergeAccelerators 保持一致；这里只需要 id → accelerator
  const merged: Record<string, string> = {}
  for (const command of EDITOR_COMMANDS) merged[command.id] = command.accelerator
  const overrides = settings?.keybindings
  if (overrides) {
    for (const [id, value] of Object.entries(overrides)) {
      if (typeof value === 'string') merged[id] = value
    }
  }
  return merged
}
