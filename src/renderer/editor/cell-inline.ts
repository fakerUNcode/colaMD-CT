// ColaMD CT：表格单元格的行内渲染，以及「显示出来的字 ↔ 源码」的映射。
//
// 表格是整块替换渲染的：格子里的 `**加粗**`、`[链接](地址)`、`$x$` 由这里拼成 DOM。
// 拼的同时记下每一个显示字符来自源码的哪一段、套在哪些格式元素里。格子就地编辑
// （table-ops 的 contenteditable）结算时靠这张表把**改动**落回源码，而不是把格子的
// 纯文本整个盖回去。
//
// 2026-11-24 用户报「点一下带格式的格子，再点另一格，格式就没了」：旧实现结算时写回的
// 是格子的 textContent，`**加粗**` 被盖成 `加粗`——而且是写进文件的真丢格式。现在：
//   - 点进去又点走、没改一个字：源码一个字节都不动；
//   - 在加粗里补了几个字：只有那几个字落进 `**…**` 里面，标记原样保留；
//   - 删掉整个加粗词：连同空掉的 `****` 一起清掉，不留残骸。
//
// 行内解析（2026-11-24 重写）：此前是一条大正则从左到右吃，`*a **b** c*` 这种嵌套会
// 配错（外层斜体在里层加粗的第一个 `*` 上提前闭合）。现在是三步：
//   1. 不透明区间先定下来：行内代码、公式、自动链接、裸网址、图片、HTML 标签、转义、实体；
//   2. 在不透明区间之外扫定界符（`**` `__` `*` `_` `~~` `==`），栈式配对：每个闭侧配
//      最近的同型开侧，天然嵌套、不交叉；
//   3. 区间树 → DOM。
// 配对规则与正文的宽松层同一套手感（开侧后一个字符非空白、闭侧前一个字符非空白，
// 下划线不跨 ASCII 词内），所以同一行字在正文里和格子里的样子一致。

import katex from 'katex'
import { scanMath, type MathRange } from './math-scan'
import { sanitizeHTML, cleanStyle } from './html-sanitize'
import { imgAttr } from '../../shared/image-syntax'

// ─── 与正文渲染层共用的小件 ──────────────────────────────────────────────────

/**
 * HTML 实体 → 字符（`&amp;` → `&`，`&#65;` → `A`）。
 *
 * 借浏览器自己的实体表：塞进 textarea 的 innerHTML 再读 value。解不出来
 * （`&nope;` 这种不存在的实体）读回的还是原文，按 CommonMark 规范保持字面。
 */
export function decodeEntity(raw: string): string | null {
  if (typeof document === 'undefined') return null
  const decoder = document.createElement('textarea')
  decoder.innerHTML = raw
  const value = decoder.value
  return value === raw || value === '' ? null : value
}

/** 把文件里的图片地址解析成浏览器能加载的地址。 */
export function resolveImageSrc(raw: string, base: string | null): string {
  const value = raw.trim().replace(/^<|>$/g, '')
  if (/^(?:https?:|file:|data:|blob:)/i.test(value)) return value
  if (!base) return value
  try {
    return new URL(value.replaceAll('\\', '/'), base).href
  } catch {
    return value
  }
}

/**
 * 画一个公式。两个调用点：正文里的 MathWidget，和表格单元格里的行内公式。
 * 渲染失败时把源码原样放回去（`cm-md-math-error`），宁可难看也不丢字。
 */
export function mathElement(code: string, block: boolean): HTMLElement {
  const el = document.createElement(block ? 'div' : 'span')
  el.className = block ? 'cm-md-math cm-md-math-block' : 'cm-md-math cm-md-math-inline'
  try {
    el.innerHTML = katex.renderToString(code, {
      displayMode: block,
      throwOnError: true,
      // 公式里可能带用户写的 HTML，KaTeX 的 trust 默认关闭，保持关闭
      trust: false,
    })
  } catch {
    el.textContent = (block ? '$$' : '$') + code + (block ? '$$' : '$')
    el.classList.add('cm-md-math-error')
  }
  return el
}

/**
 * 行内 HTML 标签的语义映射：标签名 → 样式类后缀（`cm-md-html-后缀`，样式在
 * editor-preview.css）。列在这里的标签用「藏标签 + 加样式」画，中间的文字仍是
 * 普通的 markdown。此前的实现只认带 style 的成对标签，`<u>`、`<b>`、`<sub>`
 * 这些最常见的语义标签被画成一对空元素，对文字毫无作用（2026-11-23 全语法审计）。
 */
export const HTML_SEMANTIC: Record<string, string> = {
  u: 'u', b: 'b', strong: 'b', em: 'em', i: 'em', sub: 'sub', sup: 'sup', kbd: 'kbd', mark: 'mark',
  s: 's', del: 's', strike: 's', code: 'code', samp: 'code', tt: 'code',
  ins: 'ins', small: 'small', big: 'big', q: 'q', abbr: 'abbr', var: 'var',
}

/** 空元素：没有闭标签，自成一体（`<br>`、`<img>`、`<hr>`）。 */
export const HTML_VOID = new Set(['br', 'img', 'hr', 'wbr', 'area', 'base', 'col', 'embed', 'source', 'track'])

export interface ParsedHtmlTag {
  name: string
  attrs: string
  closing: boolean
  selfClosing: boolean
}

export function parseHtmlTag(raw: string): ParsedHtmlTag | null {
  // `<br/>`、`<img/>` 这种斜杠前没有空格的自闭合写法：补一个空格再走同一条正则
  // （旧的正则要求属性段以空白起头，`<br/>` 整个匹配不上，格子里的换行就丢了）
  const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)>$/.exec(raw.replace(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)\//, '<$1 /'))
  if (!match) return null
  const selfClosing = /\/\s*$/.test(match[3] ?? '')
  return {
    name: match[2].toLowerCase(),
    attrs: (match[3] ?? '').replace(/\/\s*$/, ''),
    closing: match[1] === '/',
    selfClosing,
  }
}

// ─── 显示文字与源码的对应 ────────────────────────────────────────────────────

/**
 * 不可拆的显示单元（图片、公式、换行、整段 HTML）在「格子文字」里各占一个字符。
 * 用私有区码位，不会和正文撞；回写源码时它们整个对应各自的源码区间。
 */
export const ATOM = { image: '\uE000', math: '\uE001', br: '\uE002', html: '\uE003' } as const

/** 查找匹配的一处（格子文字的局部下标）。 */
export interface CellSearchSpan {
  from: number
  to: number
  current: boolean
}

/** 格子渲染完的快照：此刻显示的文字，以及每个字符的来历。 */
export interface CellMap {
  /** 显示文字；不可拆的单元各占一个 ATOM 字符。 */
  text: string
  /** `spans[i]`：第 i 个显示字符在格子源码里的 [from, to)。长度为 0 = 没有映射。 */
  spans: Array<[number, number]>
  /** `chains[i]`：第 i 个显示字符所在的格式元素，由外到内（strong、em、code、a…）。 */
  chains: Element[][]
}

const cellMaps = new WeakMap<HTMLElement, CellMap>()

/** 每个格子的文字在表格源码里的起点（TableWidget.toDOM 记下）：格子里的图片右键缩放时靠它换算文档位置。 */
const cellOffsets = new WeakMap<HTMLElement, number>()

export function noteCellOffset(cell: HTMLElement, offset: number): void {
  cellOffsets.set(cell, offset)
}

/**
 * 格子里某个不可拆的显示单元（图片）在文档里的源码区间；换算不出来返回 null
 * （格子不是这里渲染的、或者它里面的内容正被改过）。
 */
export function cellAtomDocRange(cell: HTMLElement, element: HTMLElement): { from: number; to: number } | null {
  const map = cellMaps.get(cell)
  const offset = cellOffsets.get(cell)
  if (!map || map.spans.length === 0 || offset === undefined) return null
  let index = 0
  let found = -1
  const walk = (node: Node): boolean => {
    if (node === element) {
      found = index
      return true
    }
    if (node.nodeType === Node.TEXT_NODE) {
      index += (node as CharacterData).data.length
      return false
    }
    if (!(node instanceof Element)) return false
    if (atomOf(node) !== null) {
      index += 1
      return false
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (walk(child)) return true
    }
    return false
  }
  walk(cell)
  if (found < 0 || found >= map.spans.length) return null
  const [from, to] = map.spans[found]
  return { from: offset + from, to: offset + to }
}

/** 渲染时记下的映射。格子不是这里渲染的（不该发生）就返回 undefined。 */
export function cellMapOf(cell: HTMLElement): CellMap | undefined {
  return cellMaps.get(cell)
}

/** 一个元素是不是「不可拆的显示单元」：是的话它在格子文字里只占一个字符，不往下走。 */
function atomOf(element: Element): string | null {
  const tag = element.tagName
  if (tag === 'IMG') return ATOM.image
  if (tag === 'BR') return ATOM.br
  if (element.classList.contains('cm-md-math')) return ATOM.math
  if (element.classList.contains('cm-md-html-inline')) return ATOM.html
  return null
}

/**
 * 算不算「格式层」：它包住的字和外面的字不是同一种排版。新输入的字贴着哪一侧的
 * 格式层，回写时就落进那一侧的标记里面。查找高亮的 span 不算（它只是颜色）。
 */
function isFormatElement(element: Element): boolean {
  switch (element.tagName) {
    case 'STRONG':
    case 'EM':
    case 'CODE':
    case 'S':
    case 'MARK':
    case 'A':
      return true
    default:
      return /(?:^|\s)cm-md-html-[a-z]+(?:\s|$)/.test(element.className)
  }
}

/** 把格子此刻的 DOM 读成「格子文字」：每个显示字符 + 它所在的格式层。 */
export function extractCell(cell: HTMLElement): { text: string; chains: Element[][] } {
  const chars: string[] = []
  const chains: Element[][] = []
  const walk = (node: Node, chain: Element[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of (node as CharacterData).data ?? '') {
        chars.push(ch)
        chains.push(chain)
      }
      return
    }
    if (!(node instanceof Element)) return
    const atom = atomOf(node)
    if (atom !== null) {
      chars.push(atom)
      chains.push(chain)
      return
    }
    const inner = node === cell ? chain : isFormatElement(node) ? [...chain, node] : chain
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child, inner)
  }
  walk(cell, [])
  return { text: chars.join(''), chains }
}

// ─── 行内解析：第 1 步，不透明区间 ───────────────────────────────────────────

interface Token {
  kind: 'escape' | 'entity' | 'code' | 'math' | 'autolink' | 'url' | 'image' | 'link' | 'html' | 'comment'
  from: number
  to: number
  /** 链接 / 成对标签：要递归渲染的内容区间（它同时是一个独立的定界符配对区）。 */
  inner?: [number, number]
  /** 链接地址在源码里的区间（空文字的链接把地址顶上来显示）。 */
  hrefRange?: [number, number]
  href?: string
  alt?: string
  contentFrom?: number
  contentTo?: number
  code?: string
  /** html：标签的解析结果。 */
  tag?: ParsedHtmlTag
}

interface Scan {
  /** 起点下标 → 从这里开始的区间。 */
  tokenAt: Map<number, Token>
  /** 定界符不许落入的位置（不透明区间的并集；链接文字、成对标签的内部不算）。 */
  opaque: Uint8Array
  /** 每个位置属于哪个「配对区」：定界符不跨区配对（链接文字里外、标签里外）。 */
  region: Int32Array
}

const IMAGE_RE = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/
const LINK_RE = /^\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/
const AUTOLINK_RE = /^<(?:[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]+|[^\s<>@]+@[^\s<>@]+)>/
const ENTITY_RE = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/
const TAG_RE = /^<\s*\/?\s*[a-zA-Z][^<>]*>/
const COMMENT_RE = /^<!--[\s\S]*?-->/
/** 裸网址到中日韩文字与全角标点为止（与正文的 URL_STOP 同一条规矩）。 */
const URL_RE = /^https?:\/\/[^\s<>\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/i
const ESCAPABLE = /[!-/:-@[-`{-~]/

interface CodeSpan {
  from: number
  to: number
  contentFrom: number
  contentTo: number
}

/** 行内代码：开侧反引号串配**等长**的闭侧串（CommonMark）。配不上的反引号是普通字符。 */
function codeSpans(text: string): CodeSpan[] {
  const out: CodeSpan[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let j = i
    while (text[j] === '`') j++
    const width = j - i
    let k = j
    let close = -1
    while (k < text.length) {
      if (text[k] === '`') {
        let m = k
        while (text[m] === '`') m++
        if (m - k === width) {
          close = k
          break
        }
        k = m
      } else {
        k++
      }
    }
    if (close < 0) {
      i = j
      continue
    }
    out.push({ from: i, to: close + width, contentFrom: j, contentTo: close })
    i = close + width
  }
  return out
}

/** 成对标签的闭标签（同名标签正确计数嵌套）；落在别的不透明区间里的不算。 */
function matchingClose(text: string, from: number, name: string, tokens: Token[]): { from: number; to: number } | null {
  const re = new RegExp(`<\\s*(/?)\\s*${name}\\s*(/?)\\s*>`, 'gi')
  re.lastIndex = from
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const found = match
    if (tokens.some((token) => token.from < found.index && found.index < token.to)) continue
    if (match[1] === '/') {
      depth--
      if (depth === 0) return { from: match.index, to: match.index + match[0].length }
    } else if (match[2] !== '/') {
      depth++
    }
  }
  return null
}

function scan(text: string, inlineMath: boolean): Scan {
  const n = text.length
  const tokens: Token[] = []
  const tokenAt = new Map<number, Token>()
  const opaque = new Uint8Array(n)
  const region = new Int32Array(n)
  /** 走到某个位置要直接跳过去（链接文字的 `]` 处、成对标签的闭标签起点）。 */
  const jumps = new Map<number, number>()
  const cover = (from: number, to: number): void => {
    for (let k = from; k < to; k++) opaque[k] = 1
  }
  const fence = (from: number, to: number, id: number): void => {
    for (let k = from; k < to; k++) region[k] = id
  }
  const add = (token: Token): void => {
    tokens.push(token)
    tokenAt.set(token.from, token)
  }

  // 公式与代码先定下来，别的区间不许跨过去
  const codes = codeSpans(text)
  for (const span of codes) {
    add({ kind: 'code', ...span })
    cover(span.from, span.to)
  }
  const math: MathRange[] = inlineMath ? scanMath(text, codes) : []
  const mathAt = new Map<number, MathRange>(math.map((range) => [range.from, range]))
  for (const range of math) cover(range.from, range.to)

  let nextRegion = 0
  let i = 0
  while (i < n) {
    const jump = jumps.get(i)
    if (jump !== undefined) {
      i = jump
      continue
    }
    const formula = mathAt.get(i)
    if (formula) {
      add({ kind: 'math', from: formula.from, to: formula.to, code: formula.code })
      i = formula.to
      continue
    }
    if (opaque[i]) {
      // 不透明区间的内部：代码已经记过，这里只剩链接地址这类被盖住的部分
      i++
      continue
    }
    const rest = text.slice(i)
    const ch = text[i]
    if (ch === '\\' && i + 1 < n && ESCAPABLE.test(text[i + 1])) {
      add({ kind: 'escape', from: i, to: i + 2 })
      cover(i, i + 2)
      i += 2
      continue
    }
    if (ch === '&') {
      const match = ENTITY_RE.exec(rest)
      if (match && decodeEntity(match[0]) !== null) {
        add({ kind: 'entity', from: i, to: i + match[0].length })
        cover(i, i + match[0].length)
        i += match[0].length
        continue
      }
    }
    if (ch === '<') {
      const comment = COMMENT_RE.exec(rest)
      if (comment) {
        add({ kind: 'comment', from: i, to: i + comment[0].length })
        cover(i, i + comment[0].length)
        i += comment[0].length
        continue
      }
      const autolink = AUTOLINK_RE.exec(rest)
      if (autolink) {
        add({ kind: 'autolink', from: i, to: i + autolink[0].length })
        cover(i, i + autolink[0].length)
        i += autolink[0].length
        continue
      }
      const raw = TAG_RE.exec(rest)
      const tag = raw ? parseHtmlTag(raw[0]) : null
      if (raw && tag) {
        const openTo = i + raw[0].length
        const token: Token = { kind: 'html', from: i, to: openTo, tag }
        if (!tag.closing && !tag.selfClosing && !HTML_VOID.has(tag.name)) {
          const close = matchingClose(text, openTo, tag.name, tokens)
          if (close) {
            token.inner = [openTo, close.from]
            token.to = close.to
            fence(openTo, close.from, ++nextRegion)
            jumps.set(close.from, close.to)
            cover(close.from, close.to)
          }
        }
        add(token)
        cover(i, openTo)
        i = openTo
        continue
      }
    }
    if (ch === '!' && text[i + 1] === '[') {
      const match = IMAGE_RE.exec(rest)
      if (match) {
        add({ kind: 'image', from: i, to: i + match[0].length, alt: match[1], href: match[2] })
        cover(i, i + match[0].length)
        i += match[0].length
        continue
      }
    }
    if (ch === '[') {
      const match = LINK_RE.exec(rest)
      if (match) {
        const labelTo = i + match[0].indexOf(']')
        const hrefFrom = text.indexOf(match[2], labelTo)
        const inner: [number, number] = [i + 1, labelTo]
        const token: Token = {
          kind: 'link', from: i, to: i + match[0].length, inner, href: match[2],
          hrefRange: [hrefFrom, hrefFrom + match[2].length],
        }
        add(token)
        cover(i, inner[0])
        cover(labelTo, token.to)
        fence(inner[0], labelTo, ++nextRegion)
        jumps.set(labelTo, token.to)
        i = inner[0]
        continue
      }
    }
    // GFM 裸网址：前面是开头、空白或开括号才算（`xhttps://` 不是）
    if ((ch === 'h' || ch === 'H') && (i === 0 || /[\s*(~_]/.test(text[i - 1]))) {
      const match = URL_RE.exec(rest)
      if (match) {
        let end = i + match[0].length
        // 句末的标点不属于网址
        while (end > i + 8 && /[.,;:!?]/.test(text[end - 1])) end--
        add({ kind: 'url', from: i, to: end })
        cover(i, end)
        i = end
        continue
      }
    }
    i++
  }
  return { tokenAt, opaque, region }
}

// ─── 行内解析：第 2 步，定界符配对 ───────────────────────────────────────────

interface Pair {
  /** 开侧标记的起点。 */
  from: number
  /** 标记长度（1 或 2）。 */
  len: number
  /** 闭侧标记的起点。 */
  closeFrom: number
  cls: string
}

interface Delim {
  char: string
  from: number
  len: number
  region: number
  openOk: boolean
  closeOk: boolean
  /** 这一串里已经当过闭侧（从左端起）、开侧（从右端起）的字符数。 */
  usedClose: number
  usedOpen: number
}

/** ASCII 词字符。`_` 的词内防误伤只看它们（snake_case_name 不能变斜体）。 */
const LOOSE_WORD_CHAR = /[A-Za-z0-9_]/
/** Unicode 词字符（含汉字）。严格方言下，下划线强调的两侧不许是它。 */
const UNICODE_WORD_CHAR = /[\p{L}\p{N}_]/u

const PAIR_CLASS: Record<string, string> = {
  '*': 'cm-md-em', '**': 'cm-md-strong', '_': 'cm-md-em', '__': 'cm-md-strong',
  '~~': 'cm-md-strike', '==': 'cm-md-highlight',
  // Typora 的上下标写法：`x^2^`、`H~2~O`。中间只认短短一串 ASCII 字母数字，
  // `5~10天，7~12天` 这类区间写法才不会被当成下标（与正文的宽松层同一条规矩）。
  '^': 'cm-md-html-sup', '~': 'cm-md-html-sub',
}

/** 上下标的夹层内容。 */
const SCRIPT_CONTENT = /^[A-Za-z0-9+-]{1,10}$/

/**
 * 每个闭侧配**最近的**同型开侧：后开的后配，配对天然嵌套；夹在中间没配上的开侧
 * 随之出栈，成了普通字。一串 `***` 可以拆成「两个当粗、一个当斜」，所以一串定界符
 * 能被配两次（`***粗斜***` 的里粗外斜）。
 */
function pairDelimiters(text: string, scanned: Scan, loose: boolean): Pair[] {
  const { opaque, region } = scanned
  const guard = loose ? LOOSE_WORD_CHAR : UNICODE_WORD_CHAR
  const pairs: Pair[] = []
  const stack: Delim[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (opaque[i] || !'*_~='.includes(ch) && ch !== '^') {
      i++
      continue
    }
    const from = i
    while (i < n && text[i] === ch) i++
    const len = i - from
    // `===`、`~~~` 不是定界符；`^` 只认单个；单个 `~` 是 Typora 的下标（`H~2~O`），两个是删除线
    if ((ch === '=' && len !== 2) || (ch === '~' && len > 2) || (ch === '^' && len !== 1)) continue
    const script = ch === '^' || (ch === '~' && len === 1)
    const before = from > 0 ? text[from - 1] : ''
    const after = i < n ? text[i] : ''
    const openOk = after !== '' && !/\s/.test(after) && !(ch === '_' && guard.test(after))
    const closeOk = from > 0 && region[from - 1] === region[from] && !/\s/.test(before) && !(ch === '_' && guard.test(before))
    const delim: Delim = { char: ch, from, len, region: region[from], openOk, closeOk, usedClose: 0, usedOpen: 0 }
    // 先尽量当闭侧：从左端起，一截一截地和最近的同型开侧配
    while (delim.closeOk && delim.len - delim.usedClose - delim.usedOpen > 0) {
      let at = -1
      for (let k = stack.length - 1; k >= 0; k--) {
        const open = stack[k]
        if (open.char === ch && open.region === delim.region && open.len - open.usedOpen - open.usedClose > 0) {
          at = k
          break
        }
      }
      if (at < 0) break
      const open = stack[at]
      // 上下标：夹层内容不合格就不配（往前找更远的开侧只会让夹层更长）
      if (script && !SCRIPT_CONTENT.test(text.slice(open.from + open.len, delim.from))) break
      const take = Math.min(2, open.len - open.usedOpen - open.usedClose, delim.len - delim.usedClose - delim.usedOpen)
      open.usedOpen += take
      delim.usedClose += take
      pairs.push({
        from: open.from + open.len - open.usedOpen,
        len: take,
        closeFrom: delim.from + delim.usedClose - take,
        cls: PAIR_CLASS[ch + (take === 2 ? ch : '')],
      })
      // 开侧还剩字符就留着继续当开侧，否则出栈
      stack.length = open.len - open.usedOpen - open.usedClose > 0 ? at + 1 : at
    }
    if (delim.len - delim.usedClose - delim.usedOpen > 0 && delim.openOk) stack.push(delim)
  }
  return pairs.sort((a, b) => a.from - b.from || b.len - a.len)
}

// ─── 行内解析：第 3 步，DOM ──────────────────────────────────────────────────

interface RenderContext {
  text: string
  base: string | null
  scanned: Scan
  pairAt: Map<number, Pair>
  marks: readonly CellSearchSpan[]
  /** 渲染时记下的显示文字（与 spans 一一对应）。 */
  pieces: string[]
  spans: Array<[number, number]>
}

/** [from, to) 这段源码被画成一个不可拆的元素时该挂的查找高亮类名；不需要就是空串。 */
function markClassCovering(marks: readonly CellSearchSpan[], from: number, to: number): string {
  let className = ''
  for (const mark of marks) {
    if (mark.from <= from && mark.to >= to) {
      if (mark.current) className = 'search-match-current'
      else className ||= 'search-match'
    }
  }
  return className
}

/** 记一段逐字对应源码的文字：第 k 个字符来自 [from + k, from + k + 1)。 */
function recordText(ctx: RenderContext, value: string, from: number): void {
  ctx.pieces.push(value)
  for (let k = 0; k < value.length; k++) ctx.spans.push([from + k, from + k + 1])
}

/** 记一段整体对应 [from, to) 的文字（解码后的实体、图片、公式）：删它就是删整段源码。 */
function recordWhole(ctx: RenderContext, value: string, from: number, to: number): void {
  ctx.pieces.push(value)
  for (let k = 0; k < value.length; k++) ctx.spans.push([from, to])
}

/**
 * 把源码 text[from, to) 写进 parent，落在这段里的查找匹配各包成一个高亮 span（越界的裁掉）。
 * 与正文里检索面板画的装饰同类名、同配色。
 */
function writeText(parent: HTMLElement, ctx: RenderContext, from: number, to: number): void {
  const markAt = (pos: number): CellSearchSpan | undefined => ctx.marks.find((mark) => mark.from <= pos && pos < mark.to)
  let cursor = from
  while (cursor < to) {
    const mark = markAt(cursor) ?? null
    let end = cursor + 1
    while (end < to && (markAt(end) ?? null) === mark) end++
    const value = ctx.text.slice(cursor, end)
    if (mark) {
      const span = document.createElement('span')
      span.className = mark.current ? 'search-match-current' : 'search-match'
      span.textContent = value
      parent.appendChild(span)
    } else {
      parent.appendChild(document.createTextNode(value))
    }
    recordText(ctx, value, cursor)
    cursor = end
  }
}

function elementFor(pair: Pair): HTMLElement {
  switch (pair.cls) {
    case 'cm-md-strong':
      return document.createElement('strong')
    case 'cm-md-em':
      return document.createElement('em')
    case 'cm-md-strike':
      return document.createElement('s')
    default: {
      const el = document.createElement(pair.cls === 'cm-md-highlight' ? 'mark' : 'span')
      el.className = pair.cls
      return el
    }
  }
}

function render(parent: HTMLElement, ctx: RenderContext, from: number, to: number): void {
  let i = from
  let plainFrom = -1
  const flush = (): void => {
    if (plainFrom < 0) return
    writeText(parent, ctx, plainFrom, i)
    plainFrom = -1
  }
  while (i < to) {
    const pair = ctx.pairAt.get(i)
    if (pair && pair.closeFrom + pair.len <= to) {
      flush()
      const el = elementFor(pair)
      parent.appendChild(el)
      render(el, ctx, i + pair.len, pair.closeFrom)
      i = pair.closeFrom + pair.len
      continue
    }
    const token = ctx.scanned.tokenAt.get(i)
    if (token && token.to <= to) {
      flush()
      emitToken(parent, ctx, token)
      i = token.to
      continue
    }
    if (plainFrom < 0) plainFrom = i
    i++
  }
  flush()
}

function emitToken(parent: HTMLElement, ctx: RenderContext, token: Token): void {
  const { text, base } = ctx
  switch (token.kind) {
    case 'escape':
      // 只显示被转义的那个字符
      writeText(parent, ctx, token.from + 1, token.to)
      break
    case 'entity': {
      const decoded = decodeEntity(text.slice(token.from, token.to)) ?? text.slice(token.from, token.to)
      const className = markClassCovering(ctx.marks, token.from, token.to)
      if (className) {
        const span = document.createElement('span')
        span.className = className
        span.textContent = decoded
        parent.appendChild(span)
      } else {
        parent.appendChild(document.createTextNode(decoded))
      }
      recordWhole(ctx, decoded, token.from, token.to)
      break
    }
    case 'code': {
      const el = document.createElement('code')
      const contentFrom = token.contentFrom ?? token.from
      const contentTo = token.contentTo ?? token.to
      const content = text.slice(contentFrom, contentTo)
      // CommonMark：内容两端同时是空格（且不全是空格）时各剥掉一格
      const strip = content.trim() && /^\s/.test(content) && /\s$/.test(content) ? 1 : 0
      writeText(el, ctx, contentFrom + strip, contentTo - strip)
      parent.appendChild(el)
      break
    }
    case 'math': {
      const el = mathElement(token.code ?? '', false)
      const className = markClassCovering(ctx.marks, token.from, token.to)
      if (className) el.classList.add(className)
      parent.appendChild(el)
      recordWhole(ctx, ATOM.math, token.from, token.to)
      break
    }
    case 'image': {
      const img = document.createElement('img')
      img.src = resolveImageSrc(token.href ?? '', base)
      img.alt = token.alt ?? ''
      const className = markClassCovering(ctx.marks, token.from, token.to)
      if (className) img.classList.add(className)
      parent.appendChild(img)
      recordWhole(ctx, ATOM.image, token.from, token.to)
      break
    }
    case 'autolink':
    case 'url': {
      const el = document.createElement('a')
      const body: [number, number] = token.kind === 'autolink' ? [token.from + 1, token.to - 1] : [token.from, token.to]
      const address = text.slice(body[0], body[1])
      el.setAttribute('href', token.kind === 'autolink' && !/^[a-z][a-z0-9+.-]*:/i.test(address) ? `mailto:${address}` : address)
      writeText(el, ctx, body[0], body[1])
      parent.appendChild(el)
      break
    }
    case 'link': {
      const el = document.createElement('a')
      const href = (token.href ?? '').replace(/^<|>$/g, '')
      if (/^(?:https?:|mailto:)/i.test(href)) el.setAttribute('href', href)
      const inner = token.inner ?? [token.from + 1, token.from + 1]
      // 空文字的链接把地址顶上来，否则格子里什么都看不见
      if (inner[1] > inner[0]) render(el, ctx, inner[0], inner[1])
      else if (token.hrefRange) writeText(el, ctx, token.hrefRange[0], token.hrefRange[1])
      parent.appendChild(el)
      break
    }
    case 'html': {
      const tag = token.tag
      if (!tag || tag.closing) break
      if (token.inner) {
        const styleAttr = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag.attrs)
        const style = styleAttr ? cleanStyle(styleAttr[1] ?? styleAttr[2] ?? '') : ''
        const otherAttrs = tag.attrs.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/i, '').trim()
        const semantic = HTML_SEMANTIC[tag.name]
        // 带其它属性（class / color…）的标签没法用「藏标签 + 加样式」表达：整段画成消毒后的
        // 真 HTML，里面的 markdown 不再解析（这是 HTML，本该如此）
        if (!semantic && otherAttrs) {
          appendHtmlAtom(parent, ctx, text.slice(token.from, token.to), token.from, token.to)
          break
        }
        // 语义标签（<u>、<b>、<sub>…）：藏掉两头的标签，给中间那段加样式，里面照常是 markdown
        const el = document.createElement('span')
        if (semantic) el.classList.add(`cm-md-html-${semantic}`)
        if (style) el.setAttribute('style', style)
        parent.appendChild(el)
        render(el, ctx, token.inner[0], token.inner[1])
        break
      }
      if (tag.name === 'img') {
        // `<img>` 标签（缩放过的图片）：按图片画，相对路径按文档地址解析，带上显式宽度
        const raw = text.slice(token.from, token.to)
        const img = document.createElement('img')
        img.src = resolveImageSrc(imgAttr(raw, 'src') ?? '', base)
        img.alt = imgAttr(raw, 'alt') ?? ''
        const width = Number.parseInt(imgAttr(raw, 'width') ?? '', 10)
        if (width > 0) img.setAttribute('width', String(width))
        const className = markClassCovering(ctx.marks, token.from, token.to)
        if (className) img.classList.add(className)
        parent.appendChild(img)
        recordWhole(ctx, ATOM.image, token.from, token.to)
        break
      }
      if (tag.name === 'br') {
        parent.appendChild(document.createElement('br'))
        recordWhole(ctx, ATOM.br, token.from, token.to)
        break
      }
      // 单标签（<img>、<hr>）或没配上对的标签：消毒后画出来
      appendHtmlAtom(parent, ctx, text.slice(token.from, token.to), token.from, token.to)
      break
    }
    // 注释不显示
    case 'comment':
      break
  }
}

/** 一段交给消毒器的 HTML：整个算一个不可拆的显示单元。 */
function appendHtmlAtom(parent: HTMLElement, ctx: RenderContext, html: string, from: number, to: number): void {
  const el = document.createElement('span')
  el.className = 'cm-md-html-inline'
  const className = markClassCovering(ctx.marks, from, to)
  if (className) el.classList.add(className)
  el.appendChild(sanitizeHTML(html))
  parent.appendChild(el)
  recordWhole(ctx, ATOM.html, from, to)
}

/**
 * 把一格源码画进 cell（th / td），并记下显示文字与源码的对应。
 * 由 live-preview 的 TableWidget.toDOM 调用。
 */
export function renderCell(
  cell: HTMLElement,
  source: string,
  base: string | null,
  inlineMath: boolean,
  loose: boolean,
  marks: readonly CellSearchSpan[] = [],
): void {
  const scanned = scan(source, inlineMath)
  const ctx: RenderContext = {
    text: source,
    base,
    scanned,
    pairAt: new Map(pairDelimiters(source, scanned, loose).map((pair) => [pair.from, pair])),
    marks,
    pieces: [],
    spans: [],
  }
  render(cell, ctx, 0, source.length)
  const extracted = extractCell(cell)
  // 记下来的和 DOM 里读出来的必须是同一串字；对不上就不给映射（结算时不敢按它回写）
  const mapped = extracted.text === ctx.pieces.join('') && extracted.text.length === ctx.spans.length
  cellMaps.set(cell, { text: extracted.text, spans: mapped ? ctx.spans : [], chains: extracted.chains })
}

// ─── 结算：把格子里的改动落回源码 ────────────────────────────────────────────

interface Op {
  /** 旧文字里被删掉的 [aFrom, aTo)。 */
  aFrom: number
  aTo: number
  /** 新文字里补上的 [bFrom, bTo)。 */
  bFrom: number
  bTo: number
}

/**
 * 字符级最长公共子序列，得出「哪几段被删、哪几段被补」。
 * 格子一般几十个字，n×m 的表足够；超长的格子只按公共前后缀切一刀。
 */
function diffOps(a: string, b: string): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > 1_600_000) {
    let head = 0
    while (head < n && head < m && a[head] === b[head]) head++
    let tail = 0
    while (tail < n - head && tail < m - head && a[n - tail - 1] === b[m - tail - 1]) tail++
    return n === m && head === n ? [] : [{ aFrom: head, aTo: n - tail, bFrom: head, bTo: m - tail }]
  }
  const w = m + 1
  // dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const dp = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (i >= n || j >= m) {
      ops.push({ aFrom: i, aTo: n, bFrom: j, bTo: m })
      break
    }
    const startI = i
    const startJ = j
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break
      if (i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) i++
      else j++
    }
    ops.push({ aFrom: startI, aTo: i, bFrom: startJ, bTo: j })
  }
  return ops
}

/** 两组格式层的贴合程度：共几个元素。两边都是普通文字也算贴合（记 1）。 */
function commonFormats(a: Element[], b: Element[]): number {
  if (a.length === 0 && b.length === 0) return 1
  return a.filter((element) => b.includes(element)).length
}

/**
 * 新输入的字该贴着哪一侧落：和哪一侧的格式层更贴合就贴哪一侧。
 * 只有一侧有邻居时，贴合格式就贴它，不贴合就躲开它（落到它的标记外面）。
 */
function sideOf(inserted: Element[], left: Element[] | null, right: Element[] | null): 'left' | 'right' {
  // 两边都没有邻居（格子原本是空的）：从头上写
  if (!left && !right) return 'left'
  const scoreLeft = left ? commonFormats(inserted, left) : commonFormats(inserted, right as Element[]) > 0 ? -1 : 1
  const scoreRight = right ? commonFormats(inserted, right) : commonFormats(inserted, left as Element[]) > 0 ? -1 : 1
  return scoreRight > scoreLeft ? 'right' : 'left'
}

/** 编辑点两侧空掉的定界符对（`****`、`**~~**`…）清掉。 */
function collapseEmpties(source: string, at: number): string {
  for (;;) {
    const ch = source[at - 1]
    if (!ch || source[at] !== ch || !'*_~='.includes(ch)) return source
    let left = 0
    while (left < 3 && source[at - left - 1] === ch) left++
    let right = 0
    while (right < 3 && source[at + right] === ch) right++
    let remove = Math.min(left, right)
    if (ch === '~' || ch === '=') {
      if (left < 2 || right < 2) return source
      remove = 2
    }
    source = source.slice(0, at - remove) + source.slice(at + remove)
    at -= remove
  }
}

/**
 * 按格子里的实际改动算出这一格新的源码。
 *
 * 每一处改动 = 删掉旧文字的一段 + 补上新文字的一段。删掉的那段在源码里对应的区间
 * 直接去掉；补上的字落在哪里看它贴着哪一侧的格式层：
 *   - 纯插入，和左邻在同一个加粗里：落在左邻字符之后、闭侧 `**` 之前（进了加粗）；
 *   - 纯插入，和右邻同为普通文字：落在右邻字符之前、开侧 `**` 之后（没进加粗）；
 *   - 替换，新字贴着左邻（或删到了格子末尾）：落在被删那段的源码起点，外层定界符照旧包着它；
 *   - 替换，新字贴着右邻：落到被删那段**之后**，连它的闭侧定界符一起跨过去（没进那一层格式）。
 * 两头之外的源码（定界符、链接的地址部分）一律保留；被删空的那层格式留下的空定界符对
 * （`****`）清掉。
 */
function editedSource(source: string, map: CellMap, now: { text: string; chains: Element[][] }): string {
  const ops = diffOps(map.text, now.text)
  let out = source
  // 从后往前落：前面改动的源码坐标不受后面改动的影响
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k]
    const inserted = now.text.slice(op.bFrom, op.bTo)
    const last = map.text.length
    const left = op.aFrom > 0 ? map.chains[op.aFrom - 1] : null
    const right = op.aTo < last ? map.chains[op.aTo] : null
    const side = sideOf(now.chains[op.bFrom] ?? [], left, right)
    if (op.aTo > op.aFrom) {
      let cutFrom = map.spans[op.aFrom][0]
      const cutTo = map.spans[op.aTo - 1][1]
      // 删掉的是转义后面的那个字符：反斜杠跟着一起走
      if (cutFrom > 0 && source[cutFrom - 1] === '\\' && ESCAPABLE.test(source[cutFrom])) cutFrom--
      if (side === 'left' || op.aTo >= last) {
        out = out.slice(0, cutFrom) + inserted + out.slice(cutTo)
      } else {
        const afterGap = map.spans[op.aTo][0]
        out = out.slice(0, cutFrom) + source.slice(cutTo, afterGap) + inserted + out.slice(afterGap)
      }
      out = collapseEmpties(out, cutFrom)
      continue
    }
    // 纯插入：落在左右邻字符之间那一段源码（定界符）的前面或后面
    const at = side === 'left' ? (op.aFrom > 0 ? map.spans[op.aFrom - 1][1] : 0)
      : (op.aFrom < last ? map.spans[op.aFrom][0] : source.length)
    out = out.slice(0, at) + inserted + out.slice(at)
  }
  return out
}

/** 格子里只有普通文字（没有任何行内语法字符）。 */
function looksPlain(source: string): boolean {
  return !/[*_~=`\[\]()<>$\\&]/.test(source)
}

/**
 * 结算格子的就地编辑：返回这一格新的源码；没有改动返回 null（源码一个字节都不用动）。
 * 调用方（table-ops 的 commitCellEdit）拿返回值和原值比，再决定要不要写回缓冲区。
 */
export function commitCellSource(cell: HTMLElement, source: string): string | null {
  const now = extractCell(cell)
  const map = cellMaps.get(cell)
  if (!map || map.spans.length === 0) {
    // 没有映射（不该发生）：只有本来就没有任何行内语法的格子，才敢按纯文本回写
    const plain = (cell.textContent ?? '').trim()
    return plain !== source.trim() && looksPlain(source) ? plain : null
  }
  if (now.text === map.text) return null
  return editedSource(source, map, now).trim()
}
