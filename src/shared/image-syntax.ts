// 图片的两种源码写法：Markdown 的 `![alt](src)`，和 HTML 的 `<img src alt width>`。
//
// 图片缩放后宽度要有地方存。Markdown 写法带不了宽度，所以缩放过的图片改写成 `<img>` 标签
// （Typora 缩放图片后也是把图片改写成 HTML 标签；GitHub、Pandoc、Obsidian 都认这个写法）。
// 解析与改写只有这一份：渲染层（正文与表格格子）、右键菜单、Word 导出都认它。

/** 整段源码就是一个 `<img …>` 标签。 */
export const IMG_TAG_RE = /^<\s*img\b[^>]*>$/i

/** `<img>` 标签里一个属性的值（双引号 / 单引号 / 不加引号都认）。 */
export function imgAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3] ?? ''
}

export interface ImageSource {
  form: 'markdown' | 'html'
  /** 文件里写的地址，原样（相对路径就是相对路径）。 */
  src: string
  alt: string
  title?: string
  /** `<img width>` 里的显式宽度（像素）；没写就是 undefined。 */
  width?: number
}

const MARKDOWN_RE = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(\s+"[^"]*")?\s*\)$/

/** 一段图片源码（两种写法都认）；不是图片返回 null。 */
export function imageSource(source: string): ImageSource | null {
  const trimmed = source.trim()
  const markdown = MARKDOWN_RE.exec(trimmed)
  if (markdown) {
    const title = markdown[3]?.trim().slice(2, -1)
    return {
      form: 'markdown',
      src: markdown[2].replace(/^<|>$/g, ''),
      alt: markdown[1],
      ...(title !== undefined && title !== '' ? { title } : {}),
    }
  }
  if (IMG_TAG_RE.test(trimmed)) {
    const width = Number.parseInt(imgAttr(trimmed, 'width') ?? '', 10)
    return {
      form: 'html',
      src: imgAttr(trimmed, 'src') ?? '',
      alt: imgAttr(trimmed, 'alt') ?? '',
      ...(width > 0 ? { width } : {}),
    }
  }
  return null
}

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * 给图片源码写上显式宽度（width 为 null = 去掉，回到按图片自身大小显示）。
 *
 *   `![图](a.png)`                        + 300 → `<img src="a.png" alt="图" width="300">`
 *   `<img src="a.png" alt="图" width="300">` + 150 → `<img src="a.png" alt="图" width="150">`
 *   同上                                   + null → `![图](a.png)`
 *
 * 去掉宽度时如果地址或替代文字里有 Markdown 写法放不下的字符（空格、括号…），就留着标签。
 */
export function writeImageWidth(source: string, width: number | null): string {
  const info = imageSource(source)
  if (!info) return source
  if (info.form === 'markdown') {
    if (width === null) return source
    const title = info.title !== undefined ? ` title="${escapeAttr(info.title)}"` : ''
    return `<img src="${escapeAttr(info.src)}" alt="${escapeAttr(info.alt)}"${title} width="${width}">`
  }
  // 旧的 width / height 去掉重来（高度跟着宽度等比走，留着会把图拉变形）
  const bare = source.trim()
    .replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s*\/?>$/, '')
  if (width === null) {
    const plain = info.title === undefined && !/[()\s<>\\]/.test(info.src) && !/[\[\]\\]/.test(info.alt)
    return plain ? `![${info.alt}](${info.src})` : `${bare}>`
  }
  return `${bare} width="${width}">`
}

/** 图片右键菜单里由渲染端执行的动作（改文档的那几个）。其余的（复制 / 打开 / 定位 / 另存）在主进程直接做。 */
export type ImageMenuAction = 'zoomIn' | 'zoomOut' | 'actualSize' | 'editSource' | 'imageInfo'

/** 右键时图片的现场（渲染端 → 主进程）：主进程据此决定菜单里哪些项可用。 */
export interface ImageMenuRequest {
  /** 图片源码在文档里的区间。 */
  from: number
  to: number
  /** 绝对地址（复制图片、打开、在文件夹中显示用）。 */
  src: string
  /** 文件里写的地址，原样（复制图片地址用）。 */
  rawSrc: string
  local: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  canActualSize: boolean
  /** 是正文里的图片（点一下有信息卡）。表格格子里的图片没有卡，就不给「图片信息」这一项。 */
  hasInfoCard: boolean
}
