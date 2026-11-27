import { isChinese } from '../ui-language'

// Layering: user preference > theme > built-in defaults. Themes keep their own
// font rules; separate body classes + CSS variables override only the requested
// properties on the editor prose and source editor (and optionally shell UI when
// applyToUi is enabled), leaving code block font families untouched.

export interface EditorFontPrefs {
  family: string
  size: number
  weight?: number
  applyToUi?: boolean
}

const STORE_KEY = 'colamd-editor-font'
export const EDITOR_FONT_CHANGE_EVENT = 'colamd-editor-font-change'

// ⌘+ / ⌘- 调的是**正文字号**，不是整页缩放。
// 范围与步进跟设置里的字号滑块一致。
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 40
export const FONT_SIZE_STEP = 1

// 字重刻度 100–900、步进 50：兼顾传统多字重字体与可变字体（Variable Font）。
export const FONT_WEIGHT_MIN = 100
export const FONT_WEIGHT_MAX = 900
export const FONT_WEIGHT_STEP = 50

/** 应用内置的开源字体（经 themes/fonts.css @font-face 加载，在字体选择器中置顶展示）。 */
export const BUNDLED_FONTS = [
  'LXGW WenKai',
  'Literata',
  'JetBrains Mono'
] as const

const BUNDLED_FONT_SET = new Set(BUNDLED_FONTS.map((f) => f.toLowerCase()))

const DEFAULT_FONT_SIZE = 16
const DEFAULT_FONT_WEIGHT = 400

function isZh(): boolean {
  return isChinese()
}

function sanitizeFamily(family: string): string {
  return family.replace(/[{};<>@]/g, '').trim()
}

export function normalizeFontSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 0
  if (size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return 0
  return Math.round(size)
}

export function normalizeFontWeight(weight: unknown): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return 0
  if (weight < FONT_WEIGHT_MIN || weight > FONT_WEIGHT_MAX) return 0
  const snapped = Math.round(weight / FONT_WEIGHT_STEP) * FONT_WEIGHT_STEP
  return Math.min(FONT_WEIGHT_MAX, Math.max(FONT_WEIGHT_MIN, snapped))
}

export function normalizeEditorFontPrefs(prefs: Partial<EditorFontPrefs> | null | undefined): EditorFontPrefs {
  return {
    family: typeof prefs?.family === 'string' ? sanitizeFamily(prefs.family) : '',
    size: normalizeFontSize(prefs?.size),
    weight: normalizeFontWeight(prefs?.weight),
    applyToUi: Boolean(prefs?.applyToUi)
  }
}

export function hasAnyEditorFontPref(prefs: Partial<EditorFontPrefs> | null | undefined): boolean {
  if (!prefs) return false
  const n = normalizeEditorFontPrefs(prefs)
  return Boolean(n.family || n.size || n.weight || n.applyToUi)
}

export function computeHeadingFontWeight(baseWeight: number): number {
  return Math.min(FONT_WEIGHT_MAX, baseWeight + 200)
}

export function computeStrongFontWeight(baseWeight: number): number {
  return Math.min(FONT_WEIGHT_MAX, baseWeight + 300)
}

export function formatFontWeightLabel(weight: number, zh: boolean): string {
  const names: Record<number, [string, string]> = {
    100: ['极细', 'Thin'],
    200: ['特细', 'Extra Light'],
    300: ['细体', 'Light'],
    400: ['常规', 'Regular'],
    500: ['中等', 'Medium'],
    600: ['半粗', 'Semi Bold'],
    700: ['粗体', 'Bold'],
    800: ['特粗', 'Extra Bold'],
    900: ['黑体', 'Black']
  }
  const pair = names[weight]
  if (!pair) return String(weight)
  return `${weight} ${zh ? pair[0] : pair[1]}`
}

export function loadSavedEditorFont(): EditorFontPrefs | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EditorFontPrefs>
    if (!hasAnyEditorFontPref(parsed)) return null
    return normalizeEditorFontPrefs(parsed)
  } catch {
    return null
  }
}

// 字体族、字号、字重各管各的，类分开挂。
//
// 2026-10-06 报「主题的字体改丢了」：⌘+ 只该改字号，却也因此挂上了 has-custom-font，
// 而那时 --editor-font 是空的，于是 base.css 里那条 `font-family: var(--editor-font)
// !important` 变成无效声明，把主题自己的字体顶掉了。只调哪一项就只挂哪一项。
export function applyEditorFont(prefs: EditorFontPrefs | null): void {
  const body = document.body
  const normalized = normalizeEditorFontPrefs(prefs)
  const { family, size, weight = 0, applyToUi = false } = normalized

  body.classList.toggle('has-custom-font', Boolean(family))
  body.classList.toggle('has-custom-font-size', Boolean(size))
  body.classList.toggle('has-custom-font-weight', Boolean(weight))
  body.classList.toggle('has-custom-ui-font', Boolean(applyToUi && (family || size || weight)))

  if (family) body.style.setProperty('--editor-font', family)
  else body.style.removeProperty('--editor-font')

  if (size) {
    body.style.setProperty('--editor-font-size', `${size}px`)
    body.style.setProperty('--editor-font-size-ratio', (size / DEFAULT_FONT_SIZE).toFixed(4))
  } else {
    body.style.removeProperty('--editor-font-size')
    body.style.removeProperty('--editor-font-size-ratio')
  }

  if (weight) {
    body.style.setProperty('--editor-font-weight', String(weight))
    body.style.setProperty('--editor-font-weight-heading', String(computeHeadingFontWeight(weight)))
    body.style.setProperty('--editor-font-weight-strong', String(computeStrongFontWeight(weight)))
  } else {
    body.style.removeProperty('--editor-font-weight')
    body.style.removeProperty('--editor-font-weight-heading')
    body.style.removeProperty('--editor-font-weight-strong')
  }

  window.dispatchEvent(new CustomEvent(EDITOR_FONT_CHANGE_EVENT, { detail: normalized }))
}

export function persistEditorFont(prefs: EditorFontPrefs): void {
  const normalized = normalizeEditorFontPrefs(prefs)
  if (!hasAnyEditorFontPref(normalized)) {
    clearEditorFont()
    return
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(normalized))
  applyEditorFont(normalized)
  // Let other windows pick the change up too (they apply it idempotently).
  window.electronAPI?.setEditorFont?.(normalized)
}

export function updateEditorFontPrefs(patch: Partial<EditorFontPrefs>): void {
  const current = loadSavedEditorFont() ?? { family: '', size: 0, weight: 0, applyToUi: false }
  persistEditorFont({ ...current, ...patch })
}

export function getEffectiveEditorFontSize(): number {
  const saved = loadSavedEditorFont()
  if (saved && saved.size >= FONT_SIZE_MIN && saved.size <= FONT_SIZE_MAX) return saved.size
  const probe = document.querySelector('#editor .cm-content')
  const computed = probe ? parseFloat(getComputedStyle(probe).fontSize) : Number.NaN
  return Number.isFinite(computed) ? Math.round(computed) : DEFAULT_FONT_SIZE
}

export function getEffectiveEditorFontWeight(): number {
  const saved = loadSavedEditorFont()
  if (saved?.weight && saved.weight >= FONT_WEIGHT_MIN && saved.weight <= FONT_WEIGHT_MAX) return saved.weight
  const probe = document.querySelector('#editor .cm-content')
  const computed = probe ? parseFloat(getComputedStyle(probe).fontWeight) : Number.NaN
  const normalized = normalizeFontWeight(computed)
  return normalized || DEFAULT_FONT_WEIGHT
}

export function stepEditorFontSize(delta: number): void {
  const saved = loadSavedEditorFont() ?? { family: '', size: 0, weight: 0, applyToUi: false }
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, getEffectiveEditorFontSize() + delta))
  persistEditorFont({ ...saved, size: next })
}

export function clearEditorFont(): void {
  localStorage.removeItem(STORE_KEY)
  applyEditorFont(null)
  window.electronAPI?.setEditorFont?.({ family: '', size: 0, weight: 0, applyToUi: false })
}

/** ⌘0：只把字号恢复成主题的默认值，用户自己挑过的字体族与字重留着。 */
export function resetEditorFontSize(): void {
  const saved = loadSavedEditorFont()
  if (!saved) return
  persistEditorFont({ ...saved, size: 0 })
}

/** 恢复字号、字重与界面同步开关到主题默认，保留用户自选的字体族。 */
export function resetEditorTypography(): void {
  const saved = loadSavedEditorFont()
  if (!saved) return
  persistEditorFont({ family: saved.family, size: 0, weight: 0, applyToUi: false })
}

export function showFontSettingsModal(): void {
  const saved = loadSavedEditorFont()
  const zh = isZh()
  const t = {
    title: zh ? '编辑器字体' : 'Editor Font',
    font: zh ? '字体' : 'Font',
    size: zh ? '字体大小' : 'Font size',
    weight: zh ? '字体粗细' : 'Font weight',
    weightHint: zh
      ? '刻度 100–900（步进 50），可变字体支持精细调节；实际档位取决于当前字体。'
      : 'Scale 100–900 (step 50) for variable fonts; visible steps depend on the active font.',
    applyToUi: zh ? '同步应用到界面文字（顶栏、文件面板等）' : 'Also apply to UI text (titlebar, file panel, etc.)',
    defaultTag: zh ? '默认' : 'Default',
    bundledTag: zh ? '内置' : 'Built-in',
    reset: zh ? '恢复默认' : 'Reset',
    cancel: zh ? '取消' : 'Cancel',
    apply: zh ? '应用' : 'Apply'
  }

  let customSize = saved?.size ?? 0
  let customWeight = saved?.weight ?? 0
  let applyToUi = Boolean(saved?.applyToUi)
  const fallbackSize = getEffectiveEditorFontSize()
  const fallbackWeight = getEffectiveEditorFontWeight()

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'math-modal font-modal'

  const header = document.createElement('h3')
  header.textContent = t.title

  const familyCol = document.createElement('div')
  familyCol.className = 'font-modal-col'

  const familyLabel = document.createElement('label')
  familyLabel.className = 'font-modal-label'
  familyLabel.textContent = t.font

  const familyInput = document.createElement('input')
  familyInput.className = 'math-modal-input font-modal-input'
  familyInput.placeholder = 'LXGW WenKai, Songti SC, Menlo…'
  familyInput.value = saved?.family ?? ''
  familyInput.autocomplete = 'off'

  // Scrollable custom font dropdown (datalist is unscrollable and can't be styled)
  const fontList = document.createElement('div')
  fontList.className = 'font-modal-list'
  fontList.style.display = 'none'
  let fontNames: string[] = [...BUNDLED_FONTS]
  void window.electronAPI.listSystemFonts?.().then((fonts) => {
    if (!fonts.length) return
    const systemOnly = fonts.filter((f) => !BUNDLED_FONT_SET.has(f.toLowerCase()))
    fontNames = [...BUNDLED_FONTS, ...systemOnly]
    if (document.activeElement === familyInput) renderFontList(familyInput.value)
  })

  let activeIndex = -1

  function renderFontList(query: string): void {
    const q = query.trim().toLowerCase()
    const items = (q ? fontNames.filter((f) => f.toLowerCase().includes(q)) : fontNames).slice(0, 1000)
    if (!items.length) {
      fontList.style.display = 'none'
      return
    }
    activeIndex = -1
    fontList.replaceChildren(...items.map((name) => {
      const item = document.createElement('div')
      item.className = 'font-modal-list-item'
      item.dataset.fontName = name
      const label = document.createElement('span')
      label.textContent = name
      item.appendChild(label)
      if (BUNDLED_FONT_SET.has(name.toLowerCase())) {
        const badge = document.createElement('span')
        badge.className = 'font-modal-list-badge'
        badge.textContent = t.bundledTag
        item.appendChild(badge)
      }
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        familyInput.value = name
        fontList.style.display = 'none'
        updatePreview()
      })
      return item
    }))
    fontList.style.display = 'block'
  }

  function hideFontList(): void {
    fontList.style.display = 'none'
    activeIndex = -1
  }

  let blurTimer: ReturnType<typeof setTimeout> | null = null
  familyInput.addEventListener('focus', () => {
    if (blurTimer) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
    renderFontList(familyInput.value)
  })
  familyInput.addEventListener('input', () => {
    renderFontList(familyInput.value)
    updatePreview()
  })
  familyInput.addEventListener('blur', () => {
    blurTimer = setTimeout(hideFontList, 150)
  })
  familyInput.addEventListener('keydown', (e) => {
    const items = fontList.querySelectorAll('.font-modal-list-item')
    if (fontList.style.display === 'none' || !items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex = e.key === 'ArrowDown'
        ? Math.min(activeIndex + 1, items.length - 1)
        : Math.max(activeIndex - 1, 0)
      items.forEach((el, i) => el.classList.toggle('active', i === activeIndex))
      items[activeIndex].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      const el = items[activeIndex] as HTMLElement
      familyInput.value = el.dataset.fontName ?? el.textContent ?? ''
      hideFontList()
      updatePreview()
    } else if (e.key === 'Escape') {
      hideFontList()
    }
  })

  // 字号滑块
  const sizeBlock = document.createElement('div')
  sizeBlock.className = 'colamd-slider-row'
  const sizeHead = document.createElement('div')
  sizeHead.className = 'colamd-slider-head'
  const sizeLabel = document.createElement('label')
  sizeLabel.className = 'font-modal-label'
  sizeLabel.textContent = t.size
  const sizeValue = document.createElement('span')
  sizeValue.className = 'colamd-slider-value'
  const sizeSlider = document.createElement('input')
  sizeSlider.type = 'range'
  sizeSlider.className = 'colamd-slider'
  sizeSlider.min = String(FONT_SIZE_MIN)
  sizeSlider.max = String(FONT_SIZE_MAX)
  sizeSlider.step = String(FONT_SIZE_STEP)
  sizeSlider.value = String(customSize || fallbackSize)
  sizeHead.append(sizeLabel, sizeValue)
  sizeBlock.append(sizeHead, sizeSlider)

  // 字重滑块
  const weightBlock = document.createElement('div')
  weightBlock.className = 'colamd-slider-row'
  const weightHead = document.createElement('div')
  weightHead.className = 'colamd-slider-head'
  const weightLabel = document.createElement('label')
  weightLabel.className = 'font-modal-label'
  weightLabel.textContent = t.weight
  const weightValue = document.createElement('span')
  weightValue.className = 'colamd-slider-value'
  const weightSlider = document.createElement('input')
  weightSlider.type = 'range'
  weightSlider.className = 'colamd-slider'
  weightSlider.min = String(FONT_WEIGHT_MIN)
  weightSlider.max = String(FONT_WEIGHT_MAX)
  weightSlider.step = String(FONT_WEIGHT_STEP)
  weightSlider.value = String(customWeight || fallbackWeight)
  const weightHint = document.createElement('div')
  weightHint.className = 'colamd-pref-hint'
  weightHint.textContent = t.weightHint
  weightHead.append(weightLabel, weightValue)
  weightBlock.append(weightHead, weightSlider, weightHint)

  // 界面文字同步勾选框
  const uiScopeLabel = document.createElement('label')
  uiScopeLabel.className = 'font-modal-checkbox'
  const uiScopeInput = document.createElement('input')
  uiScopeInput.type = 'checkbox'
  uiScopeInput.checked = applyToUi
  const uiScopeText = document.createElement('span')
  uiScopeText.textContent = t.applyToUi
  uiScopeLabel.append(uiScopeInput, uiScopeText)

  const preview = document.createElement('div')
  preview.className = 'font-modal-preview'

  const previewText = document.createElement('span')
  const previewStrong = document.createElement('strong')
  previewStrong.textContent = zh ? ' 加粗对比 Bold' : ' Bold contrast'
  preview.append(previewText, previewStrong)

  const updatePreview = (): void => {
    const family = sanitizeFamily(familyInput.value)
    const activeSize = customSize || fallbackSize
    const activeWeight = customWeight || fallbackWeight

    sizeValue.textContent = customSize ? `${customSize}px` : `${t.defaultTag} (${fallbackSize}px)`
    weightValue.textContent = customWeight
      ? formatFontWeightLabel(customWeight, zh)
      : `${t.defaultTag} (${formatFontWeightLabel(fallbackWeight, zh)})`

    preview.style.fontFamily = family || 'inherit'
    preview.style.fontSize = `${activeSize}px`
    preview.style.fontWeight = String(activeWeight)
    previewStrong.style.fontWeight = String(customWeight ? computeStrongFontWeight(customWeight) : 700)
    previewText.textContent =
      'The quick brown fox jumps over the lazy dog. 中文字体排版预览 0123456789'
  }

  sizeSlider.addEventListener('input', () => {
    customSize = normalizeFontSize(Number(sizeSlider.value))
    updatePreview()
  })
  weightSlider.addEventListener('input', () => {
    customWeight = normalizeFontWeight(Number(weightSlider.value))
    updatePreview()
  })
  uiScopeInput.addEventListener('change', () => {
    applyToUi = uiScopeInput.checked
  })
  familyInput.addEventListener('input', updatePreview)
  updatePreview()

  const footer = document.createElement('div')
  footer.className = 'math-modal-footer font-modal-footer'

  const footerLeft = document.createElement('div')
  footerLeft.className = 'font-modal-footer-group'

  const footerRight = document.createElement('div')
  footerRight.className = 'font-modal-footer-group'

  const resetBtn = document.createElement('button')
  resetBtn.textContent = t.reset
  resetBtn.className = 'math-modal-btn cancel'
  resetBtn.addEventListener('click', () => {
    clearEditorFont()
    overlay.remove()
  })

  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = t.cancel
  cancelBtn.className = 'math-modal-btn cancel'
  cancelBtn.addEventListener('click', () => overlay.remove())

  const applyBtn = document.createElement('button')
  applyBtn.textContent = t.apply
  applyBtn.className = 'math-modal-btn save'
  applyBtn.addEventListener('click', () => {
    const family = sanitizeFamily(familyInput.value)
    persistEditorFont({
      family,
      size: customSize,
      weight: customWeight,
      applyToUi
    })
    overlay.remove()
  })

  familyCol.append(familyLabel, familyInput, fontList)
  footerLeft.appendChild(resetBtn)
  footerRight.append(cancelBtn, applyBtn)
  footer.append(footerLeft, footerRight)
  modal.append(header, familyCol, sizeBlock, weightBlock, uiScopeLabel, preview, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  familyInput.focus()
}
