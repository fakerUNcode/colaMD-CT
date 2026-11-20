// ColaMD CT：图片摄取与图床上传（全部在主进程做）。
//
// 为什么不在渲染端发请求：渲染端有 CSP 管着，也不该拿到图床的 token；
// 文件复制、重名去重这些事本来就发生在文件系统里。渲染端只把字节递过来，
// 拿回一段能直接写进 `![](...)` 的地址。
//
// 地址的三种形态，对应 Typora 的三种插入策略：
//   upload    → 图床 URL（http(s)）
//   copy      → 相对路径（文档目录/copyDir/文件名），遵循官方版「保存时不动用户字节」
//               的便携路径不变量——文件里写相对路径，显示靠 file:// 基准解析
//   reference → 原样路径（拖拽已有文件时才有意义；剪贴板字节无路径可引用，退回 copy）
//
// 上传失败一律降级为本地副本而不是丢弃：宁可落一张本地图，不让用户的截图消失。

import { app, dialog, BrowserWindow } from 'electron'
import { join, dirname, extname, basename } from 'path'
import { mkdir, writeFile, readFile, rm, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { getSettings, type ImageInsertBehavior } from './settings'

export interface ImageIngestPayload {
  name: string
  mime: string
  bytes: ArrayBuffer
  /** 当前文档绝对路径；未命名文档为 null。 */
  docPath: string | null
  /** 拖拽已有文件时的原路径；剪贴板粘贴为 null。 */
  sourcePath?: string | null
}

export interface PickedImage {
  name: string
  mime: string
  bytes: ArrayBuffer
  sourcePath: string
}

export type ImageIngestResult =
  | { ok: true; src: string; warning?: string }
  | { ok: false; error: string }

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/avif': '.avif',
}

function hash8(bytes: ArrayBuffer): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex').slice(0, 8)
}

function today(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}${mm}${dd}`
}

/** 清成一段能当文件名的文字：去掉路径、非法字符，空了就叫 image。 */
function sanitizeName(name: string, mime: string): string {
  let base = basename(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (!base) base = 'image'
  if (!extname(base)) base += EXT_BY_MIME[mime] ?? '.png'
  return base.slice(0, 120)
}

/** 按 settings.namePattern 生成文件名。 */
function applyNamePattern(pattern: string, fileName: string, digest: string): string {
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  const mapped = pattern
    .replaceAll('{name}', stem)
    .replaceAll('{hash}', digest)
    .replaceAll('{date}', today())
  const cleaned = mapped.replace(/[\\/:*?"<>|\s]/g, '-')
  return `${cleaned || stem || 'image'}${ext}`
}

/** 已存在就 -2、-3 往后排，别静默覆盖用户磁盘上同名的图。 */
async function dedupedPath(dir: string, fileName: string): Promise<string> {
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  let candidate = join(dir, fileName)
  for (let i = 2; ; i++) {
    try {
      await stat(candidate)
      candidate = join(dir, `${stem}-${i}${ext}`)
    } catch {
      return candidate
    }
  }
}

/** 复制到文档目录（或无标题文档时 ~/.colamd/images）。返回应写进 markdown 的地址。 */
async function copyToLocal(payload: ImageIngestPayload): Promise<string> {
  const settings = getSettings().image
  const digest = hash8(payload.bytes)
  const fileName = applyNamePattern(settings.namePattern, sanitizeName(payload.name, payload.mime), digest)

  if (payload.docPath) {
    const dir = join(dirname(payload.docPath), settings.copyDir || 'assets')
    await mkdir(dir, { recursive: true })
    // 拖拽已有文件且就在目标位置：直接返回原相对名，不用写第二份
    const target = await dedupedPath(dir, fileName)
    await writeFile(target, Buffer.from(payload.bytes))
    const relative = `${(settings.copyDir || 'assets').replaceAll('\\', '/')}/${basename(target)}`
    // 源码里的图片地址不能带裸空格（`![](a b.png)` 会被解析器截断），空格转 %20；
    // 渲染端的 file:// 基准解析会把它解回真实文件名。中文等非 ASCII 字符不用动。
    return relative.replaceAll(' ', '%20')
  }

  // 未命名文档没有「文档目录」可相对，落到 ~/.colamd/images/yyyyMM/，先写绝对路径，
  // 用户另存文档后可以再用「复制到本地」重新落一份相对的。
  const now = new Date()
  const monthDir = join(app.getPath('home'), '.colamd', 'images', `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`)
  await mkdir(monthDir, { recursive: true })
  const target = await dedupedPath(monthDir, fileName)
  await writeFile(target, Buffer.from(payload.bytes))
  return target.replaceAll('\\', '/')
}

// ─── 上传：各家图床 ───────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

/** PicGo 桌面版自带的 HTTP 服务：POST {list:[本地临时文件路径]} → result:[url]。 */
async function uploadViaPicGo(bytes: ArrayBuffer, fileName: string, url: string): Promise<string> {
  const tempDir = join(app.getPath('temp'), 'colamd-ct-upload')
  await mkdir(tempDir, { recursive: true })
  const tempPath = join(tempDir, `${Date.now()}-${fileName}`)
  await writeFile(tempPath, Buffer.from(bytes))
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: [tempPath] }),
    })
    const body = (await response.json()) as { success?: boolean; result?: string[] }
    const url_out = Array.isArray(body.result) ? body.result[0] : undefined
    if (!response.ok || !body.success || !url_out) {
      throw new Error(`PicGo 响应异常（HTTP ${response.status}）。确认 PicGo 正在运行、Server 已开启。`)
    }
    return url_out
  } finally {
    void rm(tempPath, { force: true }).catch(() => {})
  }
}

/** GitHub 仓库图床：PUT contents API。 */
async function uploadViaGitHub(bytes: ArrayBuffer, fileName: string): Promise<string> {
  const cfg = getSettings().image.github
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    throw new Error('GitHub 图床缺少 token / owner / repo，请在偏好设置里补全。')
  }
  const digest = hash8(bytes)
  const repoPath = `${cfg.path.replace(/^\/+|\/+$/g, '')}/${today()}/${digest}${extname(fileName)}`
  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(repoPath)}`
  const body = JSON.stringify({
    message: `ColaMD CT: upload ${fileName}`,
    content: Buffer.from(bytes).toString('base64'),
    branch: cfg.branch || 'main',
  })
  const response = await fetchWithTimeout(api, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body,
  })
  if (response.status === 422) {
    throw new Error('GitHub：同名文件已存在（或分支不对）。可把文件名模板加上 {hash} 重试。')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub 上传失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const data = (await response.json()) as { content?: { download_url?: string } }
  if (cfg.useJsDelivr) {
    return `https://cdn.jsdelivr.net/gh/${cfg.owner}/${cfg.repo}@${cfg.branch || 'main'}/${repoPath}`
  }
  const download = data.content?.download_url
  if (!download) throw new Error('GitHub 响应里没有 download_url。')
  return download
}

/** SM.MS：multipart 字段 smfile + Authorization。重复图会回 images 字段。 */
async function uploadViaSmms(bytes: ArrayBuffer, fileName: string, mime: string): Promise<string> {
  const cfg = getSettings().image.smms
  if (!cfg.token) throw new Error('SM.MS 缺少 API Token，请在偏好设置里填写。')
  const form = new FormData()
  form.append('smfile', new Blob([bytes], { type: mime }), fileName)
  const response = await fetchWithTimeout('https://sm.ms/api/v2/upload', {
    method: 'POST',
    headers: { Authorization: cfg.token },
    body: form,
  })
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean
    code?: string
    images?: string
    data?: { url?: string }
    message?: string
  }
  if (body.success && body.data?.url) return body.data.url
  // 同内容重复上传：接口不再给 data.url，把现成地址放在 images 里
  if (body.code === 'image_repeated' && body.images) return body.images
  throw new Error(`SM.MS 上传失败：${body.message ?? `HTTP ${response.status}`}`)
}

function pickByPath(value: unknown, dottedPath: string): string | undefined {
  let node: unknown = value
  for (const key of dottedPath.split('.').filter(Boolean)) {
    if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return typeof node === 'string' && node ? node : undefined
}

/** 自定义 HTTP 上传：multipart + 可配字段名/请求头/响应取值路径。 */
async function uploadViaCustom(bytes: ArrayBuffer, fileName: string, mime: string): Promise<string> {
  const cfg = getSettings().image.custom
  if (!cfg.url) throw new Error('自定义图床没有配置上传地址。')
  const form = new FormData()
  form.append(cfg.fieldName || 'image', new Blob([bytes], { type: mime }), fileName)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(cfg.headers ?? {})) {
    if (key.toLowerCase() !== 'content-type' && typeof value === 'string') headers[key] = value
  }
  const response = await fetchWithTimeout(cfg.url, { method: 'POST', headers, body: form })
  const text = await response.text()
  if (!response.ok) throw new Error(`自定义图床返回 HTTP ${response.status}：${text.slice(0, 200)}`)
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // 整个响应体就是 URL 的裸文本服务也存在，认下来
    if (/^https?:\/\/\S+$/i.test(text.trim())) return text.trim()
    throw new Error('自定义图床的响应不是 JSON，也不是纯 URL。')
  }
  if (cfg.responsePath) {
    const url = pickByPath(json, cfg.responsePath)
    if (url) return url
    throw new Error(`按路径 ${cfg.responsePath} 没能在响应里取到 URL。`)
  }
  // 没配路径就试常见形状
  for (const guess of ['url', 'data.url', 'data.link', 'data.images.url', 'result.0', 'data.0.url']) {
    const url = pickByPath(json, guess)
    if (url) return url
  }
  throw new Error('无法从自定义图床的响应里识别 URL；请在「响应路径」里写明，如 data.url。')
}

async function uploadImage(bytes: ArrayBuffer, fileName: string, mime: string): Promise<string> {
  const provider = getSettings().image.uploadProvider
  if (provider === 'picgo') return uploadViaPicGo(bytes, fileName, getSettings().image.picgo.url || 'http://127.0.0.1:36677/upload')
  if (provider === 'github') return uploadViaGitHub(bytes, fileName)
  if (provider === 'smms') return uploadViaSmms(bytes, fileName, mime)
  return uploadViaCustom(bytes, fileName, mime)
}

/**
 * 摄取一张图。behavior 为空时按设置里的 insertBehavior（ask 已在渲染端问过、
 * 选完才带行为进来，所以主进程只认三种实际行为）。
 */
export async function ingestImage(
  payload: ImageIngestPayload,
  behavior?: Exclude<ImageInsertBehavior, 'ask'>,
): Promise<ImageIngestResult> {
  const action = behavior ?? (getSettings().image.insertBehavior === 'ask' ? 'upload' : getSettings().image.insertBehavior)
  try {
    if (action === 'reference' && payload.sourcePath) {
      return { ok: true, src: payload.sourcePath.replaceAll('\\', '/') }
    }
    if (action === 'upload') {
      const fileName = sanitizeName(payload.name, payload.mime)
      try {
        return { ok: true, src: await uploadImage(payload.bytes, fileName, payload.mime) }
      } catch (error) {
        // 上传失败不丢图：降级落一份本地副本，并把原因带回给渲染端提一句
        // （Typora 的失败路径是弹错不插图，我们宁可先落本地图。）
        const src = await copyToLocal(payload)
        const warning = error instanceof Error ? error.message : String(error)
        return { ok: true, src, warning: `${warning}（已改存本地副本）` }
      }
    }
    return { ok: true, src: await copyToLocal(payload) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 「插入图片…」菜单：文件对话框多选，读出字节走同一条摄取管线。 */
export async function pickImageFiles(win: BrowserWindow | null): Promise<PickedImage[] | null> {
  const result = await dialog.showOpenDialog(win!, {
    title: '插入图片',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: Object.keys(MIME_BY_EXT).map((ext) => ext.slice(1)) },
    ],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const picked: PickedImage[] = []
  for (const filePath of result.filePaths) {
    try {
      const bytes = await readFile(filePath)
      const ext = extname(filePath).toLowerCase()
      picked.push({
        name: basename(filePath),
        mime: MIME_BY_EXT[ext] ?? 'image/png',
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        sourcePath: filePath,
      })
    } catch {
      // 读不了的单个文件跳过，别拦住其余的
    }
  }
  return picked.length ? picked : null
}
