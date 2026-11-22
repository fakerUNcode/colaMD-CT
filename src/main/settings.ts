// ColaMD CT：统一设置存储。
//
// 官方版没有设置中心——主题、面板、字号各存各的（localStorage 或各自的 JSON）。
// CT 加的两块配置（图床上传、快捷键改绑）都需要主进程与渲染端同时读到：
// 上传在主进程做（绕开渲染端 CSP），快捷键同时驱动菜单（主进程）和键盘（渲染端），
// 所以放进 userData/settings.json，两边经 IPC 读写同一份。

import { app } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { mergeAccelerators, isValidAccelerator } from '../shared/commands'
import type { AppSettings, ImageSettings, ImageInsertBehavior, ImageUploadProvider, MarkdownDialectSettings, TableSettings, SettingsPatch } from '../shared/settings-types'

export type { AppSettings, ImageSettings, ImageInsertBehavior, ImageUploadProvider, MarkdownDialectSettings, TableSettings, SettingsPatch }

export const DEFAULT_SETTINGS: AppSettings = {
  image: {
    insertBehavior: 'ask',
    rememberChoice: false,
    uploadProvider: 'picgo',
    copyDir: 'assets',
    namePattern: '{name}-{hash}',
    picgo: { url: 'http://127.0.0.1:36677/upload' },
    github: { token: '', owner: '', repo: '', branch: 'main', path: 'images', useJsDelivr: false },
    smms: { token: '' },
    custom: { url: '', fieldName: 'image', headers: {}, responsePath: '' },
  },
  markdown: { looseEmphasis: true, inlineMath: true, highlight: true },
  table: { rememberWidths: true },
  keybindings: {},
}

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

let current: AppSettings = loadFromDisk()

function sanitizedMarkdown(value: unknown): Partial<MarkdownDialectSettings> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const out: Partial<MarkdownDialectSettings> = {}
  for (const key of ['looseEmphasis', 'inlineMath', 'highlight'] as const) {
    if (typeof source[key] === 'boolean') out[key] = source[key] as boolean
  }
  return out
}

function sanitizedTable(value: unknown): Partial<TableSettings> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  return typeof source.rememberWidths === 'boolean' ? { rememberWidths: source.rememberWidths } : {}
}

function loadFromDisk(): AppSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>
    return {
      image: { ...DEFAULT_SETTINGS.image, ...(sanitizedImage(parsed.image)) },
      markdown: { ...DEFAULT_SETTINGS.markdown, ...(sanitizedMarkdown(parsed.markdown)) },
      table: { ...DEFAULT_SETTINGS.table, ...(sanitizedTable(parsed.table)) },
      keybindings: sanitizedBindings(parsed.keybindings),
    }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

function sanitizedImage(value: unknown): Partial<ImageSettings> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const behaviors: ImageInsertBehavior[] = ['ask', 'upload', 'copy', 'reference']
  const providers: ImageUploadProvider[] = ['picgo', 'github', 'smms', 'custom']
  for (const section of ['picgo', 'github', 'smms', 'custom'] as const) {
    if (source[section] && typeof source[section] === 'object') {
      out[section] = { ...(DEFAULT_SETTINGS.image[section] as object), ...(source[section] as object) }
    }
  }
  if (typeof source.insertBehavior === 'string' && behaviors.includes(source.insertBehavior as ImageInsertBehavior)) out.insertBehavior = source.insertBehavior
  if (typeof source.rememberChoice === 'boolean') out.rememberChoice = source.rememberChoice
  if (typeof source.uploadProvider === 'string' && providers.includes(source.uploadProvider as ImageUploadProvider)) out.uploadProvider = source.uploadProvider
  if (typeof source.copyDir === 'string') out.copyDir = source.copyDir.replace(/[\\/:*?"<>|]/g, '').trim() || 'assets'
  if (typeof source.namePattern === 'string' && source.namePattern.trim()) out.namePattern = source.namePattern.trim().slice(0, 100)
  return out
}

function sanitizedBindings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [id, accel] of Object.entries(value as Record<string, unknown>)) {
    if (typeof accel !== 'string') continue
    if (accel !== '' && !isValidAccelerator(accel)) continue
    out[id] = accel
  }
  return out
}

export function getSettings(): AppSettings {
  return current
}

/** 当前生效的「命令 → accelerator」表（默认 + 覆盖）。菜单与渲染端各取各的实例。 */
export function getMergedAccelerators(): Record<string, string> {
  return mergeAccelerators(current.keybindings)
}

function persist(): void {
  const target = settingsPath()
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(current, null, 2), 'utf-8')
  } catch {
    // 写不进的设置不值得弹窗打断用户；本次会话内仍然生效。
  }
}

/** 局部合并 + 落盘。返回合并后的完整设置。 */
export function updateSettings(patch: SettingsPatch): AppSettings {
  if (patch?.image) current.image = { ...current.image, ...sanitizedImage(patch.image) }
  if (patch?.markdown) current.markdown = { ...current.markdown, ...sanitizedMarkdown(patch.markdown) }
  if (patch?.table) current.table = { ...current.table, ...sanitizedTable(patch.table) }
  if (patch?.keybindings) current.keybindings = { ...current.keybindings, ...sanitizedBindings(patch.keybindings) }
  persist()
  return current
}

export { settingsPath }
