// Live preview 装饰层：把 markdown 源码画成所见即所得的样子。
//
// 硬规矩（见 docs/editor-architecture.md）：**装饰不许修改文档。**
// 这里只做两件事：
//   1. 给语法加样式（Decoration.mark / Decoration.line）——标记字符照旧在，只是被画得轻一些。
//   2. 把光标不在其内的标记字符藏起来（Decoration.replace）——只是「看不见」，
//      文本还在，保存时一个字节都不变。
//
// 「藏起来」的判据是光标位置：光标进入某个区间时，标记字符显形，用户可以就地编辑。
// Obsidian 的 Live Preview 就是这个行为。
//
// 一个反复出现的形状：**渲染失败宁可退回源码，绝不吞掉用户的字。**
// 公式渲不出来就显示 `$...$`，mermaid 画不出来就显示代码块。文件永远是安全的，
// 装饰层再错也只是难看。
//
// 装饰装在 StateField 里、用 `provide` 暴露，**不能用 `EditorView.decorations.compute()`**。
// 原因不是风格问题：CodeMirror 把「函数式提供的装饰」标记为动态，而动态装饰
// **不许跨行替换**，命中就抛 `RangeError: Decorations that replace line breaks may not
// be specified via plugins`（node_modules/@codemirror/view/dist/index.cjs:2780）。
// 块公式、属性区、mermaid、表格都是跨行替换，用 compute 提供会让整层装饰更新中途抛错，
// 表现为「整个界面错乱」。StateField + provide 提供的是装饰集本身，不是函数，
// 跨行替换与块级 widget 才被允许。

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import { forceParsing, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import { scanMath, excludedRanges, frontmatterRange, type Excluded, type MathRange } from './math-scan'
import { renderMermaid, attachDiagramZoom, detachDiagramZoom, isDiagramZoomed } from './mermaid-bridge'
import { searchStateField } from './search-highlight'
import { sanitizeHTML, cleanStyle } from './html-sanitize'
import {
  renderCell, mathElement, decodeEntity, resolveImageSrc, parseHtmlTag, HTML_SEMANTIC, HTML_VOID, noteCellOffset,
  type CellSearchSpan,
} from './cell-inline'
import { IMG_TAG_RE, imgAttr } from '../../shared/image-syntax'
import { footnoteDefinitions, footnoteNumbers, FOOTNOTE_REF_RE } from './footnotes'
import { isChinese } from '../ui-language'
import { attachColumnResize, applyPendingCellFocus } from './table-ops'

/** 给区间加样式类，不隐藏任何字符。 */
const MARK = Decoration.mark.bind(Decoration)
/**
 * 块级元素用行装饰。
 *
 * 为什么不能用 `MARK`：`Decoration.mark` 只包住它范围内的文字，一个跨多行的区间
 * 会被拆成好几段文字盒子，而 CM6 里真正撑满正文宽度的是 `.cm-line`。
 * 用 mark 包表格，表格宽度就由文字长度决定（实测被压到 90px，应为 880px）。
 */
const BLOCK = (className: string) => Decoration.line({ class: className })
/** 把一个跳行区间展开成逐行的行装饰。 */
function pushBlockLines(
  state: EditorState,
  from: number,
  to: number,
  className: string,
  ranges: DecorationRange[],
): void {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  for (let n = first; n <= last; n++) {
    const lineFrom = state.doc.line(n).from
    ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK(className) })
  }
}
/**
 * 列表项：只给它**自己那一行**加类，不给它子列表里的行加。
 *
 * 一个 ListItem 的区间包含它下面的子列表，按区间铺类的话，嵌套项那一行会同时拿到
 * 外层和内层的类（实测一行上同时挂着 `cm-md-li-0` 和 `cm-md-li-1`），缩进只是靠 CSS
 * 里规则的前后顺序才侥幸对。所以每一行都要问一次语法树：包住这一行的**最内层**
 * ListItem 是不是我自己。
 */
const QUOTE_PREFIX_RE = /^(?:[ \t]*> ?)+/

function hasListSpace(state: EditorState, markTo: number): boolean {
  const ch = markTo < state.doc.length ? state.doc.sliceString(markTo, markTo + 1) : ''
  return ch === ' ' || ch === '\t'
}

function pushListItemLines(state: EditorState, node: SyntaxNode, ranges: DecorationRange[]): void {
  const selfMark = node.getChild('ListMark')
  // 孤立一个 `-` 或 `1.`（后面还没敲空格）不算成型的列表项，等空格落下再缩进。
  if (!selfMark || !hasListSpace(state, selfMark.to)) return
  const className = `cm-md-li cm-md-li-${Math.min(listDepth(node), 6)}`
  const tree = syntaxTree(state)
  // 行没有 li 外壳，续行也没有 ListMark。把语法树里已有的归属带到导出层，
  // 表格、空行与父项续文才不会被误认成另一项；这里只记录位置，不另存内容。
  const path: { list: number; item: number; start?: number }[] = []
  let quoted = false
  for (let ancestor: SyntaxNode | null = node; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name === 'Blockquote') quoted = true
    if (ancestor.name !== 'ListItem') continue
    const list = ancestor.parent!
    const mark = ancestor.getChild('ListMark')
    const start = list.name === 'OrderedList' && mark ? Number.parseInt(state.sliceDoc(mark.from, mark.to), 10) : undefined
    path.unshift({ list: list.from, item: ancestor.from, ...(start === undefined ? {} : { start }) })
  }
  const attributes = { 'data-list-path': JSON.stringify(path), 'data-list-quoted': String(quoted) }
  const paragraphs = node.getChildren('Paragraph')

  // 子列表之前的行一定是这一项自己的（包括项里的空行），不用问语法树。
  let ownEnd = node.to
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'BulletList' || child.name === 'OrderedList') {
      ownEnd = child.from
      break
    }
  }

  const first = state.doc.lineAt(node.from).number
  const ownLast = state.doc.lineAt(node.to).number
  // 同一列表的相邻项目间空行属于分隔，不让导出把一张列表截成两张。
  const last = node.nextSibling?.name === 'ListItem' ? state.doc.lineAt(node.nextSibling.from).number - 1 : ownLast
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    if (n > first && n <= ownLast && line.to <= ownEnd) {
      // 用户在空列表项按回车退出列表后直接顶格打字，CommonMark 仍把无缩进的下一行算作懒续行；
      // 没有缩进的非空行已经退出列表，不该继续挂列表缩进和归属。
      const body = line.text.replace(QUOTE_PREFIX_RE, '')
      if (body.trim() !== '' && !/^[ \t]/.test(body)) break
    }
    if (n <= ownLast && line.to > ownEnd) {
      // 子列表里的行：问语法树，包住这一行的**最内层** ListItem 得是我自己。
      // 位置取行内第一个非空白字符（跳过引用前缀与缩进）——从行首问会问到外层那一项。
      const quoteLen = QUOTE_PREFIX_RE.exec(line.text)?.[0].length ?? 0
      const indent = /^[ \t]*/.exec(line.text.slice(quoteLen))?.[0].length ?? 0
      const at = Math.min(line.from + quoteLen + indent, line.to)
      let owner: SyntaxNode | null = tree.resolveInner(at, 1)
      while (owner && owner.name !== 'ListItem') owner = owner.parent
      if (!owner || owner.from !== node.from) continue
      const body = line.text.slice(quoteLen)
      if (body.trim() !== '' && !/^[ \t]/.test(body)) break
    }
    const paragraph = paragraphs.find(block => block.from <= line.to && block.to > line.from)
    ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: className, attributes: {
      ...attributes,
      ...(paragraph ? { 'data-list-paragraph': String(paragraph.from) } : {}),
    } }) })
  }
}

/** 本次构建里由 hide() 造出的替换装饰。组装前要认出它们（见 buildDecorations 的过滤）。 */
const hiddenDecos = new WeakSet<Decoration>()

/** 把区间藏起来（只是看不见，文本还在）。 */
const hide = (from: number, to: number) => {
  const deco = Decoration.replace({})
  hiddenDecos.add(deco)
  return deco
}

/** 画一段与源码不同的文字（HTML 实体解码后的字符）。 */
class TextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: TextWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.textContent = this.text
    return span
  }
}

/**
 * 藏掉一个标记字符，**连同它后面那个空格**。
 *
 * markdown 的标记（`#`、`>`）与正文之间那个空格不属于标记节点，只藏标记的话，
 * 标题与引用的文字会比正文右移一个字：`# 标题` 藏掉 `#` 剩下 ` 标题`。
 * 这个偏移很小，但正是「前置对齐不对」的全部来源。
 */
function hideMarker(state: EditorState, from: number, to: number, ranges: DecorationRange[], visible = false): void {
  const next = to < state.doc.length ? state.doc.sliceString(to, to + 1) : ''
  // 空格不可能是换行，所以 to + 1 不会越到下一行
  const end = next === ' ' || next === '\t' ? to + 1 : to
  // 光标在这一行时标记要露出来（这是「当前行看源码」的手感），但它不属于正文。
  // 给它一个类名，复制和导出才认得出它并丢掉：2026-09-26 发现，在一行里选一段带加粗的
  // 文字，纯文本里带着 `**`，因为标记只在光标离开这一行时才从 DOM 里消失。
  ranges.push({ from, to: end, deco: visible ? MARK({ class: 'cm-md-marker' }) : hide(from, end) })
}

interface DecorationRange {
  from: number
  to: number
  deco: Decoration
}

/** 一个区间（属性区）。 */
interface Range {
  from: number
  to: number
}

/** 位置是否落在某个区间内。区间为 null 时永远不命中。 */
function inRange(range: Range | null, pos: number): boolean {
  return !!range && pos >= range.from && pos < range.to
}

/**
 * 遍历语法树，跳过属性区。
 *
 * 属性区里是 YAML，不是 markdown：`- `、`---`、`**`、`#` 在那里都只是普通字符。
 * 解析器不认 YAML，会把它们解析成列表项、分隔线、加粗，所以在这里统一挡掉，
 * 而不是让每个收集器各写一遍判断。
 *
 * `Document` 不能跳过：它的起点就是属性区的起点，跳过它整棵树都不用看了。
 */
function iterateContent(
  state: EditorState,
  front: Range | null,
  enter: (node: SyntaxNodeRef) => boolean | void,
): void {
  syntaxTree(state).iterate({
    enter: (node) => {
      if (front && node.name !== 'Document' && inRange(front, node.from)) return false
      return enter(node)
    },
  })
}

/**
 * 编辑器当前是否有焦点。
 *
 * 光标处的标记披露（见 revealEnabled）是给**正在编辑**的人用的。但打开文件时 CodeMirror
 * 的光标就在正文开头，于是第一行的 `#` 会一直露着：用户没点过它，看起来就是个 bug
 * （2026-09-26 报的，当时是「第一行一直显示源码」）。所以判据里加上焦点：没有焦点，
 * 就没有正在编辑的构造。
 */
export const setEditorFocus = StateEffect.define<boolean>()

export const editorFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocus)) return effect.value
    }
    return value
  },
})

function editorFocused(state: EditorState): boolean {
  return state.field(editorFocusField, false) ?? false
}

/**
 * 导出时的「干净」开关。
 *
 * 导出的是一篇文档，不是编辑器此刻的样子：正在编辑的那一行显形的源码、
 * 光标、选区都不该跟着进 PDF。导出前把它打开，导出后关掉。
 */
/**
 * 文档自己的 `file://` URL。
 *
 * 文件里写的是 `![](img/a.png)` 这样的**相对**路径——那是用户文件里真实存在的一串字，
 * 不许改（改了就等于保存时动用户的文件）。但浏览器要的是一个能加载的绝对地址，
 * 所以解析放在画图这一刻做，用文档自己的 URL 当基准。
 *
 * 值同时留在模块变量里：换文件会重建整个 EditorState，field 会被 create 重置，
 * 只有模块变量能跨过去。
 */
let documentFileUrl: string | null = null

/** 编辑器还没建起来时也要能先记下基准，否则第一张图会按空基准解析。 */
export function primeDocumentFileUrl(url: string | null): void {
  documentFileUrl = url
}

/**
 * 异步画出来的东西（图、公式）会改变块级 widget 的高度，而这个高度是 CodeMirror 在
 * 渲染那一刻量过就记住的。它变高之后，下面每一行屏幕上所在的位置都比 CodeMirror 记的
 * 低，鼠标点正文时光标就落到下一行（#199 里那张图那一条）。画完让编辑器重新量一次。
 *
 * widget 拿不到 view（WidgetType 没有这个入口），所以创建 view 的时候记一份在这里。
 */
let measureHost: EditorView | null = null

export function setMeasureHost(view: EditorView | null): void {
  measureHost = view
}

function remeasureAfterDraw(): void {
  if (!measureHost) return
  const view = measureHost
  try {
    // 只喊 requestMeasure 不管用：CodeMirror 判断「内容要不要重新量」看的是内容元素
    // 自己的高度变没变，而 `.cm-content` 带着它自带的 `min-height: 100%`，永远至少
    // 一屏高，里面的块长高了它也不变。量之前先把这个下限撤掉，高度差异就露出来了；
    // 量完（write 阶段）放回去，屏幕上什么也看不见。
    const dom = view.contentDOM
    dom.style.minHeight = '0'
    view.requestMeasure({
      read: () => null,
      write: () => {
        dom.style.minHeight = ''
      },
    })
  } catch {
    // view 已经销毁了就什么也不用做
  }
}

export const setDocumentFileUrlEffect = StateEffect.define<string | null>()

export const documentFileUrlField = StateField.define<string | null>({
  create: () => documentFileUrl,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDocumentFileUrlEffect)) {
        documentFileUrl = effect.value
        return effect.value
      }
    }
    return value
  },
})

/** `![alt](src)` / `![alt](<src> "title")`。解析不了就返回 null，退回源码。 */
function parseImage(source: string): { alt: string; src: string } | null {
  const match = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)$/.exec(source.trim())
  if (!match) return null
  return { alt: match[1], src: match[2] }
}

/**
 * 图片。
 *
 * 加载不出来就把源码原样放回去——和公式、mermaid 一样的规矩：宁可难看，不吞用户的字。
 * 点击图片不需要额外处理：光标落进这一行，这一行就退回源码，路径可以直接改。
 */
/**
 * 被替换掉的块都在自己身上带着「我在文档里的哪一段」。
 *
 * 点一下它就要能回到源码里改（#138：换内核之后表格、图、图片点进去没反应，而 2.6 是
 * 可以改的）。公式从第一天就是这么做的，这里把同一件事推广到每个替换块，
 * 由 editor.ts 里一个统一的点击处理器收尾。
 */
function withSourceRange<T extends HTMLElement>(el: T, from: number, to: number): T {
  el.dataset.sourceFrom = String(from)
  el.dataset.sourceTo = String(to)
  return el
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly source: string,
    readonly from: number,
    readonly to: number,
    /** `<img width>` 里的显式宽度（像素）；0 = 按图片自身大小。 */
    readonly width = 0,
    /** 源码是 `<img>` 标签（缩放过的图片），不是 `![]()`。 */
    readonly html = false,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.from === this.from && other.to === this.to
      && other.width === this.width && other.html === this.html
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = this.html ? 'cm-md-image cm-md-image-html' : 'cm-md-image'
    withSourceRange(wrap, this.from, this.to)
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    if (this.width > 0) img.setAttribute('width', String(this.width))
    img.addEventListener('load', () => {
      remeasureAfterDraw()
    })
    img.addEventListener('error', () => {
      wrap.classList.add('cm-md-image-failed')
      wrap.textContent = this.source
      remeasureAfterDraw()
    })
    wrap.appendChild(img)
    return wrap
  }
}

export const setCleanExport = StateEffect.define<boolean>()

export const cleanExportField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCleanExport)) return effect.value
    }
    return value
  },
})

// ─── Markdown 方言（ColaMD CT，偏好设置可热切换）──────────────────────────────
//
// 官方语法树是严格 CommonMark/GFM：成对标记（**、*、__、_、~~）的闭合判定把
// 全角标点当「标点」，于是 `**加粗**。`、`（**粗**）` 整个失效——中文用户最常
// 踩的「加粗有时候不显示」（2026-11-22）。方言开关住在 StateField 里：
//   looseEmphasis  渲染层补画被严格规则拒掉的成对标记（只放宽标点侧判定，
//                  空格侧仍从严：`** 粗**` 依旧不渲染，与 Typora/Obsidian 一致）
//   inlineMath     关掉后行内 `$x$` 退回普通文字（块级 `$$` 不受影响）
//   highlight      关掉后 `==高亮==` 不再渲染
// 缓冲区字节永远不动——这是装饰层的事。

export interface DialectOptions {
  looseEmphasis: boolean
  inlineMath: boolean
  highlight: boolean
}

let documentDialect: DialectOptions = { looseEmphasis: true, inlineMath: true, highlight: true }

/** 编辑器建起来之前先记一份（第一帧装饰就用它）。 */
export function primeDialect(options: Partial<DialectOptions>): void {
  documentDialect = { ...documentDialect, ...options }
}

export const setDialectEffect = StateEffect.define<DialectOptions>()

export const dialectField = StateField.define<DialectOptions>({
  create: () => documentDialect,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDialectEffect)) {
        documentDialect = effect.value
        return effect.value
      }
    }
    return value
  },
})

function dialectOf(state: EditorState): DialectOptions {
  return state.field(dialectField, false) ?? documentDialect
}

function exportingCleanly(state: EditorState): boolean {
  return state.field(cleanExportField, false) ?? false
}

// ─── 光标处披露标记（ColaMD CT，2026-11-23）──────────────────────────────────
//
// 上游在 2026-10-06 定成「渲染模式永远不露标记」，要改 `**` 只能切源码模式；更早
// 以前则是「光标所在的那一行整行露源码」，后来因为太吵被取消。这里按用户要求做成
// Typora 的手感——**按构造披露**：光标落在哪个构造上，只有那个构造的标记临时显形
// （压淡成 --text-muted），同一行其它地方的加粗、链接保持干净的排版；光标移开即隐藏。
//
//   强调 / 行内代码 / 高亮 / 转义 / 成对行内标签：光标在构造内，或紧贴它的两端
//   链接：光标在链接文字里面（只是挨着链接时不把网址翻出来）
//   图片：光标在图片源码的开头（信息卡「编辑地址」把光标放的那里）
//   标题的 #、列表的 -、引用的 >：光标在标记上，或紧贴标记之后
//
// 纯装饰，缓冲区不动。只有**正在编辑**时才披露（编辑器有焦点、可编辑）——打开文件时
// 光标本来就在正文开头，第一行的 `#` 不该自己冒出来。导出、放映（编辑器只读）时也
// 不披露：纸上的、幕上的都不该带标记。
//
// 装饰的重算门（livePreviewField）靠 revealKeyOf 判断「光标换了一个构造」才重算，
// 在构造内部逐字移动不重算。

/** 这些语法树节点的标记会随光标显形。 */
const REVEAL_NODES = new Set([
  'Emphasis', 'StrongEmphasis', 'Strikethrough', 'InlineCode', 'Link', 'Image', 'Autolink', 'Escape',
  'HeaderMark', 'ListMark', 'QuoteMark',
])

/** 此刻能不能披露：编辑器有焦点且可编辑才披露；导出与放映时不披露。 */
function revealEnabled(state: EditorState): boolean {
  return editorFocused(state) && !exportingCleanly(state) && state.facet(EditorView.editable) !== false
}

/** 光标（空选区）或选区整体是否落在 [from, to] 里，两端都算。 */
function within(state: EditorState, from: number, to: number): boolean {
  if (!revealEnabled(state)) return false
  const sel = state.selection.main
  return sel.from >= from && sel.to <= to
}

/** 行首标记连它后面那个空格一起算的终点。`markTo` 是标记自己的终点。 */
function lineMarkEnd(state: EditorState, markTo: number): number {
  const next = markTo < state.doc.length ? state.doc.sliceString(markTo, markTo + 1) : ''
  return next === ' ' || next === '\t' ? markTo + 1 : markTo
}

/**
 * 某个可披露构造此刻是否披露。重算门（revealKeyOf）与各收集器共用这一个判据，
 * 两边永远给出同一个答案。
 */
function constructRevealed(state: EditorState, node: SyntaxNode): boolean {
  if (!REVEAL_NODES.has(node.name)) return false
  switch (node.name) {
    case 'Link':
      // 光标在链接文字里面才翻出 `[文字](网址)`；只是挨着链接时不翻
      return within(state, node.from + 1, node.to - 1)
    case 'Image':
      // 光标在图片源码的开头才退回源码（信息卡「编辑地址」放光标的位置）；
      // 紧跟在图片后面打字时图片照常显示
      return within(state, node.from, node.to - 1)
    case 'HeaderMark':
    case 'ListMark':
    case 'QuoteMark': {
      const lineFrom = state.doc.lineAt(node.from).from
      return within(state, lineFrom, lineMarkEnd(state, node.to))
    }
    default:
      return within(state, node.from, node.to)
  }
}

/** 正则类的可披露构造（高亮、宽松强调、成对行内 HTML、脚注引用）——它们不在语法树里。 */
interface RevealExtra {
  from: number
  to: number
}

const extrasByDeco = new WeakMap<DecorationSet, RevealExtra[]>()

/**
 * 当前选区下「哪些构造披露着」的指纹。指纹没变，装饰就不必重算。
 *
 * 必须与各收集器问出同一个答案，否则会出现「判据说披露、门却没放行」的陈旧装饰。
 * 所以这里不猜几何，直接把可能披露的节点问一遍：
 *   - 选区在同一行：枚举**这一行上碰到的所有节点**。不能只从光标往上找祖先——
 *     带缩进的标题 / 子列表项（`  # 标题`）里，光标停在缩进上时，`#` 是光标所在
 *     块的后代而不是祖先，往上找不到。
 *   - 选区跨行：能披露的构造必然整个包住选区（见 within），也就是两端点的祖先。
 * 正则类的构造（高亮、宽松强调、成对行内 HTML、脚注引用）不在语法树里，直接比对区间。
 */
function revealKeyOf(state: EditorState, extras: RevealExtra[]): string {
  if (!revealEnabled(state)) return ''
  const parts: string[] = []
  const visit = (name: string, from: number, to: number, node: SyntaxNode): void => {
    if (REVEAL_NODES.has(name) && constructRevealed(state, node)) parts.push(`${name}:${from}:${to}`)
  }
  const sel = state.selection.main
  const tree = syntaxTree(state)
  const firstLine = state.doc.lineAt(sel.from)
  const lastLine = state.doc.lineAt(sel.to)
  if (firstLine.number === lastLine.number) {
    tree.iterate({
      from: firstLine.from,
      to: firstLine.to,
      enter: (node) => {
        visit(node.name, node.from, node.to, node.node)
      },
    })
  } else {
    for (const pos of [sel.from, sel.to]) {
      for (const side of [1, -1] as const) {
        let node: SyntaxNode | null = tree.resolveInner(pos, side)
        while (node) {
          visit(node.name, node.from, node.to, node)
          node = node.parent
        }
      }
    }
  }
  for (const extra of extras) {
    if (sel.from >= extra.from && sel.to <= extra.to) parts.push(`x:${extra.from}:${extra.to}`)
  }
  return parts.join('|')
}

/**
 * 查找面板的「当前项」是否落在 [from, to) 里。
 *
 * 查找高亮是标记装饰，只对页面上真实存在的文字有用；公式、图、HTML 块、链接里
 * 藏起来的地址，它们在缓冲区里的那段文字被 widget 换掉了或藏起来了，高亮落不上去
 * （用户报的「查找时表格里的文字不高亮，只跳到位置」）。当前项落在这样的区间里时，
 * 让它临时退回源码，高亮就落在看得见的文字上；翻到别处再渲染回去。
 *
 * 只看当前项、不看全部匹配：搜一个常见词时满页的图不该一起翻成源码。表格不走这条
 * 路——表格在单元格里自己画全部匹配的高亮（见 TableWidget）。
 */
function searchCurrentIn(state: EditorState, from: number, to: number): boolean {
  const search = state.field(searchStateField, false)
  if (!search) return false
  const current = search.matches[search.current]
  return current !== undefined && current.from < to && current.to > from
}

/** 落在 [from, to) 里的匹配项，带上「是不是当前项」。表格 widget 画单元格高亮用。 */
export interface SearchSpan {
  from: number
  to: number
  current: boolean
}

function searchSpansIn(state: EditorState, from: number, to: number): SearchSpan[] {
  const search = state.field(searchStateField, false)
  if (!search) return []
  const spans: SearchSpan[] = []
  for (let index = 0; index < search.matches.length; index++) {
    const match = search.matches[index]
    if (match.from < to && match.to > from) spans.push({ from: match.from, to: match.to, current: index === search.current })
  }
  return spans
}

/**
 * 块级 widget（表格、图、HTML 块、块公式）的判据：光标落进块里就露源码。
 *
 * 这些块是把**整段源码**替换成渲染结果的，光标一落进去，打出来的字写进的是被盖住的
 * 源码。所以光标进块时把源码露出来，点走再渲染回去。Obsidian 对表格就是这么做的，
 * 也是 2026-10-15 对 #153 的裁定。
 *
 * 行内的标记不在此列（2026-10-06 定）：光标所在的行不再整行露源码，要改标记去源码模式。
 * 两端都算在内：点表格落在源码第一行开头，那是块的起点，也算「在里面」。
 */
function isBlockActive(state: EditorState, from: number, to: number): boolean {
  const sel = state.selection.main
  return sel.from >= from && sel.to <= to
}

// ─── 公式 ────────────────────────────────────────────────────────────────────

/**
 * 公式渲染。判定交给 math-scan.ts（照 Obsidian 的保守规则），这里只负责画。
 *
 * 行内公式用 Widget 覆盖原文，而不是把 `$x$` 藏起来再插一段渲染结果：
 * 两者视觉相同，覆盖的写法不必分别处理两个定界符的位置。
 *
 * 光标所在行照旧退回原文，用户可以就地改。渲染失败时显示 `$...$` 源码。
 *
 * widget 上带着源码区间（见 `withSourceRange`）：点它要能就地编辑，
 * 而 DOM 里除了这里没有别的地方知道这段公式在缓冲区里的位置。
 */
class MathWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly block: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.code === this.code && other.block === this.block && other.from === this.from && other.to === this.to
  }

  toDOM(): HTMLElement {
    return withSourceRange(mathElement(this.code, this.block), this.from, this.to)
  }
}

/**
 * 无序列表的圆点。
 *
 * CM6 里没有 `ul`/`li` 元素，`-` 只是一段普通文字，圆点得自己画。
 * 有序列表的序号不画：它是文件里的字，屏幕上就该是那个字（增删列表项时由
 * list-renumber.ts 把序号写回文件，不是靠画出来的假数字）。
 */
class ListBulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-li-bullet'
    span.textContent = '•'
    return span
  }
}

/** 数一个列表项的嵌套深度（往上数几层 ListItem）。 */
function listDepth(node: SyntaxNode): number {
  let depth = 0
  let cur: SyntaxNode | null = node.parent
  while (cur) {
    if (cur.name === 'ListItem') depth++
    cur = cur.parent
  }
  return depth
}

/** 扫描公式并压入装饰。 */
function collectMath(
  state: EditorState,
  text: string,
  excluded: Excluded[],
  ranges: DecorationRange[],
  zones: ActiveZone[],
  inlineMath: boolean,
  /** 宽松强调要避开这些区间（公式已被替换装饰盖住，里面不能再叠标记）。 */
  occupy?: { from: number; to: number }[],
  /** 整段被换成 widget 的区间，高亮 `==` 不许跨过去配对（公式里 `==` 是等号）。 */
  opaque?: { from: number; to: number }[],
  /** 本次构建里真的画成了 widget 的公式区间（组装前用它滤掉嵌在里面的隐藏装饰）。 */
  widgetRanges?: { from: number; to: number }[],
): void {
  for (const range of scanMath(text, excluded)) {
    if (!range.block && !inlineMath) continue
    occupy?.push({ from: range.from, to: range.to })
    opaque?.push({ from: range.from, to: range.to })
    // ColaMD CT（2026-11-22 修重大 bug）：行内公式也注册成 zone 并在光标落进
    // 区间时退回源码。此前行内公式「永不显形」+ 点击永远只落到区间起点，
    // 表现为「只有第一次点击有效，之后点哪儿光标都不动」。显形后源码就是
    // 普通文字，原生点击/方向键随便定位；光标离开区间重新渲染。zone 让
    // activeZonesKey 在光标进出公式时变化，#201 的重算门才会放行。
    zones.push({ from: range.from, to: range.to, kind: 'block' })
    // 光标落进区间，或查找的当前项落进区间：退回源码（后者见 searchCurrentIn）
    if (isBlockActive(state, range.from, range.to) || searchCurrentIn(state, range.from, range.to)) {
      // `\(`/`\[` 的定界符占两个字符，`$` 占一个：标记要盖住完整的定界符
      const head = text.slice(range.from, range.from + 2)
      const delim = range.block || head === '\\(' || head === '\\[' ? 2 : 1
      ranges.push({ from: range.from, to: range.from + delim, deco: MARK({ class: 'cm-md-marker' }) })
      ranges.push({ from: range.to - delim, to: range.to, deco: MARK({ class: 'cm-md-marker' }) })
      continue
    }
    widgetRanges?.push({ from: range.from, to: range.to })
    ranges.push({
      from: range.from,
      to: range.to,
      deco: Decoration.replace({ widget: new MathWidget(range.code, range.block, range.from, range.to) }),
    })
  }
}

// ─── 高亮 `==文字==` ─────────────────────────────────────────────────────────
//
// 这是本站自己的语法（milkdown 时代由 highlight.ts 定义）。文本优先之后它只需要
// 一条装饰：把 `==` 藏起来、给中间加个底色。没有节点要建，也没有规则要注册。

/** `==高亮==` 的匹配。不吃跨行，也不吃空的 `====`。 */
// ColaMD CT：允许跨软换行（`前==高亮\n续行==后`），但不跨空行
const HIGHLIGHT_RE = /(?<![=])==(?!=)((?:(?!\n\s*\n)[^=])+?)==(?!=)/g

function collectHighlight(
  state: EditorState,
  text: string,
  ranges: DecorationRange[],
  excluded: Excluded[],
  enabled: boolean,
  occupy?: { from: number; to: number }[],
  extras?: RevealExtra[],
  /** 被整个换成 widget 的行内构造（图片、公式），见 buildDecorations 的 opaque。 */
  opaque: { from: number; to: number }[] = [],
): void {
  if (!enabled) return
  const inExcluded = (pos: number) => excluded.some((e) => pos >= e.from && pos < e.to)

  HIGHLIGHT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HIGHLIGHT_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // 跳过一处配对后从开侧定界符后面接着扫：它可能一路吃到了后文真正的 `==高亮==` 的开侧，
    // 照默认的 lastIndex 往下走，后文那一对就永远配不上
    if (inExcluded(start)) {
      HIGHLIGHT_RE.lastIndex = start + 2
      continue
    }
    // 配对不许跨过图片或公式：里面的 `==` 不是定界符——base64 图片地址的结尾就是 `==`，
    // 公式里 `==` 是等号。以前从图片地址里那一个 `==` 一直吃到后文真正的 `==高亮==`，
    // 中间几行全被当成高亮，后文那对定界符反而少了一半（2026-11-23 回归里撞出来的）。
    if (opaque.some((span) => start < span.to && end > span.from)) {
      HIGHLIGHT_RE.lastIndex = start + 2
      continue
    }
    // 光标在这段高亮里（或紧贴两端）时定界符 `==` 显形
    const active = within(state, start, end)
    // 藏定界符，给中间那段加底色；光标在这一行时定界符露出来，但仍要能认出来
    const delimiter = (from: number, to: number) =>
      active ? MARK({ class: 'cm-md-marker' }) : hide(from, to)
    occupy?.push({ from: start, to: end })
    extras?.push({ from: start, to: end })
    ranges.push({ from: start, to: start + 2, deco: delimiter(start, start + 2) })
    ranges.push({ from: end - 2, to: end, deco: delimiter(end - 2, end) })
    ranges.push({ from: start + 2, to: end - 2, deco: MARK({ class: 'cm-md-highlight' }) })
  }
}

// ─── 任务列表的复选框 ────────────────────────────────────────────────────────

/**
 * `- [ ]` / `- [x]` 的方括号画成真的复选框。
 *
 * 这里只是「画」：点击行为在 editor.ts 里，它改写源码里的那一个字符。
 * 也就是说勾选是**一次真的文本编辑**，可撤销、可保存，不是藏在某棵树里的状态。
 */
class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = this.checked ? 'cm-md-task cm-md-task-checked' : 'cm-md-task'
    box.textContent = this.checked ? '☑' : '☐'
    return box
  }
}

function collectTaskItems(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
      if (node.name !== 'TaskMarker') return
      // 复选框**始终**画成复选框，光标停在那一行也一样（#136）。
      // 别的标记在这一行会退回源码，好让人能改到标记本身；复选框不需要这样：
      // 勾没勾是点出来的，而 `- [ ]` 这几个字符没人会手敲，退回源码只是多一步。
      const raw = state.doc.sliceString(node.from, node.to)
      const checked = /x/i.test(raw)
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new TaskCheckboxWidget(checked) }),
      })
  })
}

// ─── Mermaid 图 ──────────────────────────────────────────────────────────────

/**
 * ```mermaid 代码块画成图。
 *
 * 渲染是异步的（引擎要懒加载），所以先放一个占位，画好了再原地替换。
 * 失败就把代码块原样留着——图是锦上添花，代码是用户写的东西。
 */
class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly key: string, readonly from: number, readonly to: number) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return other.key === this.key && other.from === this.from && other.to === this.to
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid'
    withSourceRange(wrap, this.from, this.to)
    wrap.textContent = isChinese() ? '图表渲染中…' : 'Rendering diagram…'

    // **不指定**配色：图是画在代码块底色上的，颜色由 `--pele-*` 那组变量从主题推出来
    // （themes/editor-preview.css 的 `.cm-md-mermaid`），换主题不用重画。
    // 这里曾经按应用主题挑明暗两套调色板，可 elegant 和 bear 是浅色主题配深色代码块，
    // 于是深底上画出了浅色主题的图：连线 #333 落在 #2c2c2c 上，边缘文字几乎看不见
    // （2026-09-26 用户报的「线条和背景色太接近」）。现在没有「挑一套」这回事了。
    void renderMermaid(this.code)
      .then((svg) => {
        wrap.innerHTML = svg
        wrap.classList.add('cm-md-mermaid-ready')
        // 画不下的图（被 max-width 压窄了）才真出得来控件（#129）
        attachDiagramZoom(wrap)
        // 图比占位高，块高变了：不重新量，下面几行的坐标就全偏（#199）
        remeasureAfterDraw()
      })
      .catch(() => {
        // 画不出来就退回代码块，绝不吞掉用户的图
        wrap.textContent = '```mermaid\n' + this.code + '\n```'
        wrap.classList.add('cm-md-mermaid-failed')
        remeasureAfterDraw()
      })
    return wrap
  }

  destroy(dom: HTMLElement): void {
    detachDiagramZoom(dom)
  }

  ignoreEvent(event: Event): boolean {
    if (!POINTER_EVENTS.has(event.type)) return false
    const target = event.target
    if (!(target instanceof Element)) return false
    // 控件上的事不给编辑器管：否则 mousedown 一落，CM 就把光标放到块里，块退回源码、图当场
    // 没了（另有一条「点渲染块跳源码」在 editor.ts，那边按控件和放大态各挡一道）。
    if (target.closest('.pele-zoom')) return true
    // 放大之后按住拖是在挪图，不是在选字
    const host = target.closest<HTMLElement>('.cm-md-mermaid')
    return !!host && isDiagramZoomed(host)
  }
}

// 编辑器管的事件里，只有指针那一小拨需要抢：滚轮、滚动、键盘都照旧归编辑器。
const POINTER_EVENTS = new Set([
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'touchstart',
  'touchend',
])

/**
 * Mermaid 块此刻是否显示源码：光标在里面，或查找的当前项在里面（见 searchCurrentIn）。
 * 画图的地方和围栏标记的收集器（collectInline）都要问这同一个问题，答案必须一致。
 */
function mermaidSourceShown(state: EditorState, from: number, to: number): boolean {
  return isBlockActive(state, from, to) || searchCurrentIn(state, from, to)
}

function collectMermaid(
  state: EditorState,
  text: string,
  ranges: DecorationRange[],
  front: Range | null,
  zones: ActiveZone[],
): void {
  iterateContent(state, front, (node) => {
      if (node.name !== 'FencedCode') return
      // 第一行是 ```mermaid 才画
      const firstLineEnd = text.indexOf('\n', node.from)
      if (firstLineEnd === -1) return
      const opening = text.slice(node.from, firstLineEnd).trim()
      if (!/^(`{3,}|~{3,})\s*mermaid\s*$/.test(opening)) return
      // 去掉开头的 ```mermaid 行与结尾的 ```
      const bodyStart = firstLineEnd + 1
      const lastLineStart = text.lastIndexOf('\n', node.to - 1)
      const code = text.slice(bodyStart, lastLineStart === -1 ? node.to : lastLineStart)
      if (!code.trim()) return
      zones.push({ from: node.from, to: node.to, kind: 'block' })
      // 查找命中图里的文字（节点标签）时也退回源码：画出来的图里高亮落不上去
      if (mermaidSourceShown(state, node.from, node.to)) return
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new MermaidWidget(code, `${node.from}:${code.length}`, node.from, node.to) }),
      })
  })
}

// ─── 属性区（YAML frontmatter）─────────────────────────────────────────────────
//
// 属性区是笔记开头的 metadata。它**必须留在缓冲区里**（见 #109：拆出去单独保管、
// 保存时再拼回来的做法曾经把用户的 YAML 改写成非法内容），但它不该在阅读时占地方。
//
// 展示上做一件事：**收起来**。光标落在里面（准备改它）时才露出来，和「只有光标所在
// 行露源码」是同一条规则。2026-09-26 一度改成压淡显示，结果 #138 报上来：从 2.6 升
// 上来的人第一眼就看到文首多出几行 YAML，而它本来不在「所见即所得」的范围里。
// 不折叠、不画成卡片、不换成一个「属性区」按钮：那些都是拿凭空造出来的控件替掉用户
// 文件里真实存在的内容。收起时不画任何东西，布局上就像它不在。
function collectFrontmatter(
  state: EditorState,
  ranges: DecorationRange[],
  front: Range | null,
  zones: ActiveZone[],
): void {
  if (!front) return
  zones.push({ from: front.from, to: front.to, kind: 'frontmatter' })
  // 光标在里面就露。这里不看焦点：光标停在一个被收起来的块里而窗口没有焦点时，
  // 下一句敲进去的字会落在看不见的地方。
  const editing = state.selection.ranges.some(
    (range) => range.empty && range.head >= front.from && range.head <= front.to
  )
  // 查找的当前项落在属性区里时也露出来（收起时这段文字在页面上不存在）
  if (editing || searchCurrentIn(state, front.from, front.to)) {
    pushBlockLines(state, front.from, front.to, 'cm-md-frontmatter', ranges)
    return
  }
  ranges.push({ from: front.from, to: front.to, deco: Decoration.replace({}) })
  // 被替换掉的那几行会留下一行空行占着位置，顶上就会多出一条空白（2.6 没有）。
  // 这一行本来就是个空壳，直接压成零高。
  const firstLine = state.doc.lineAt(front.from)
  ranges.push({ from: firstLine.from, to: firstLine.from, deco: Decoration.line({ class: 'cm-md-frontmatter-folded' }) })
}

// ─── 表格 ────────────────────────────────────────────────────────────────────

/**
 * 表格画成真的 `<table>`。
 *
 * 为什么这里不像别的块一样「只加样式」：markdown 表格的单元格在源码里只是被 `|`
 * 隔开的文字，行是一个个独立的 div，**没有任何办法给单元格画边框、做对齐**。
 * 只加底色的结果是几条彩色横条，不是表格。Obsidian 与 Typora 都是把表格渲染成真表格，
 * 光标进去才回到源码，这里照做。
 *
 * 光标落在表格的任意一行里时退回源码，所以改表格仍然是改文字。
 *
 * ColaMD CT（2026-11-23）：查找高亮。表格是整块替换的，查找面板的标记装饰落不到
 * 格子里的文字上（用户报的「Ctrl+F 时表格里的文字不高亮，只跳到位置」）。所以把落在
 * 表格里的匹配交给 widget，在单元格里自己画：其余匹配一个色，当前项一个色，与正文一致。
 */
class TableWidget extends WidgetType {
  /** 匹配集合的指纹：换一个「当前项」也算变（当前项要换色，DOM 得重建）。 */
  private readonly marksKey: string

  constructor(
    readonly source: string,
    readonly base: string | null,
    readonly from: number,
    readonly to: number,
    readonly inlineMath = true,
    readonly looseEmphasis = true,
    /** 落在这张表里的查找匹配（缓冲区绝对位置），见 searchSpansIn。 */
    readonly marks: readonly SearchSpan[] = [],
  ) {
    super()
    this.marksKey = marks.map((mark) => `${mark.from}:${mark.to}${mark.current ? '*' : ''}`).join(',')
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.base === this.base && other.from === this.from && other.to === this.to
      && other.inlineMath === this.inlineMath && other.looseEmphasis === this.looseEmphasis
      && other.marksKey === this.marksKey
  }

  toDOM(): HTMLElement {
    const rows = parseTableCells(this.source)
    const table = document.createElement('table')
    table.className = 'cm-md-table-widget'
    withSourceRange(table, this.from, this.to)
    if (rows.length === 0) {
      table.textContent = this.source
      return table
    }
    const [head, , ...body] = rows
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    head.forEach((cell, index) => {
      const th = document.createElement('th')
      th.style.textAlign = alignOf(rows[1]?.[index]?.text ?? '')
      // ColaMD CT：单元格的行内渲染与「显示文字 ↔ 源码」的映射都在 cell-inline.ts
      renderCell(th, cell.text, this.base, this.inlineMath, this.looseEmphasis, cellMarks(cell, this.from, this.marks))
      noteCellOffset(th, this.from + (cell.map[0] ?? 0))
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const row of body) {
      const tr = document.createElement('tr')
      for (let i = 0; i < head.length; i++) {
        const td = document.createElement('td')
        td.style.textAlign = alignOf(rows[1]?.[i]?.text ?? '')
        const cell = row[i]
        if (cell) {
          renderCell(td, cell.text, this.base, this.inlineMath, this.looseEmphasis, cellMarks(cell, this.from, this.marks))
          noteCellOffset(td, this.from + (cell.map[0] ?? 0))
        }
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    // ColaMD CT：colgroup 列宽 + 表头拖拽把手（见 table-ops.ts）
    attachColumnResize(table, this.source)
    // ColaMD CT：单元格编辑链上的下一格焦点（Tab/Enter 提交重建后接上）
    applyPendingCellFocus(table)
    return table
  }
}

/** 表格源码里的一个单元格：显示用的文字，以及每个字在表格源码里的下标。 */
interface TableCell {
  text: string
  /** `text[j]` 在表格源码里的下标（`\|` 的两个字符算一个，记 `|` 那个的位置）。 */
  map: number[]
}

/** 按行拆表格源码，行内按未转义的 `|` 拆单元格。 */
function parseTableCells(source: string): TableCell[][] {
  const rows: TableCell[][] = []
  let lineStart = 0
  for (const line of source.split('\n')) {
    const lineOffset = lineStart
    lineStart += line.length + 1
    if (line.trim() === '') continue
    // 行首的空白、行首那根管子被去掉了，记下总共去了几个字符，格子里的下标才对得上源码
    // （行尾那根管子去掉不影响前面的下标，不算）
    const trimmedLine = line.trim()
    const trimmed = trimmedLine.replace(/^\|/, '').replace(/\|$/, '')
    const offset = lineOffset + (line.length - trimmedLine.length) + (trimmedLine.startsWith('|') ? 1 : 0)
    const cells: TableCell[] = []
    let current = ''
    let map: number[] = []
    // 首尾空白不属于格子文字：文字裁掉，下标表跟着裁
    const flush = (): void => {
      const text = current.trim()
      const lead = current.length - current.trimStart().length
      cells.push({ text, map: map.slice(lead, lead + text.length) })
      current = ''
      map = []
    }
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]
      if (char === '\\' && trimmed[i + 1] === '|') {
        current += '|'
        map.push(offset + i + 1)
        i++
        continue
      }
      if (char === '|') {
        flush()
        continue
      }
      current += char
      map.push(offset + i)
    }
    flush()
    rows.push(cells)
  }
  return rows
}

/**
 * 落在某个单元格文字里的查找匹配，换算成格子文字的局部下标。
 * 越出格子文字的（管子、破折号、首尾空白）裁掉；一格文字都没盖住的不要。
 */
function cellMarks(cell: TableCell, tableFrom: number, marks: readonly SearchSpan[]): SearchSpan[] {
  const { map } = cell
  const local: SearchSpan[] = []
  for (const mark of marks) {
    let from = 0
    while (from < map.length && tableFrom + map[from] < mark.from) from++
    let to = from
    while (to < map.length && tableFrom + map[to] < mark.to) to++
    if (to > from) local.push({ from, to, current: mark.current })
  }
  return local
}

/** 分隔行里的对齐标记：`:---` 左、`:---:` 居中、`---:` 右。 */
function alignOf(delimiter: string): string {
  const cell = delimiter.trim()
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

function collectTables(
  state: EditorState,
  ranges: DecorationRange[],
  front: Range | null,
  zones: ActiveZone[],
): void {
  iterateContent(state, front, (node) => {
      if (node.name !== 'Table') return
      zones.push({ from: node.from, to: node.to, kind: 'block' })
      // 光标在表格里就退回源码：改表格就是改文字（#153）
      if (isBlockActive(state, node.from, node.to)) {
        pushBlockLines(state, node.from, node.to, 'cm-md-table', ranges)
        return false
      }
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({
          widget: new TableWidget(
            state.doc.sliceString(node.from, node.to),
            state.field(documentFileUrlField, false) ?? documentFileUrl,
            node.from,
            node.to,
            dialectOf(state).inlineMath,
            dialectOf(state).looseEmphasis,
            searchSpansIn(state, node.from, node.to)
          )
        }),
      })
      return false
  })
}

// ─── 链接 ────────────────────────────────────────────────────────────────────

/**
 * 链接画成链接。
 *
 * `[文字](地址)` 里，地址在非编辑行藏起来：正文里只该看到链接文字（Obsidian 就是这样）。
 * 要改地址，把光标点进这一行，源码就回来了。
 *
 * 文字上带 `data-href`，而不是把整段换成 `<a>` widget：换成 widget 的话，链接文字里的
 * 加粗、行内代码就全没了。点击行为在 editor.ts 里，它认 `data-href`。
 */
/** 引用式链接的标签比对的规范化：大小写不敏感，连续空白算一个空格（CommonMark）。 */
function normalizeLinkLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 文档里的引用式链接定义：`[id]: https://… "标题"` → 规范化标签 → 地址。 */
function linkReferenceDefinitions(state: EditorState, front: Range | null): Map<string, string> {
  const defs = new Map<string, string>()
  iterateContent(state, front, (node) => {
    if (node.name !== 'LinkReference') return
    const label = node.node.getChild('LinkLabel')
    const url = node.node.getChild('URL')
    if (!label || !url) return false
    defs.set(normalizeLinkLabel(state.doc.sliceString(label.from + 1, label.to - 1)), state.doc.sliceString(url.from, url.to))
    return false
  })
  return defs
}

function collectLinks(state: EditorState, ranges: DecorationRange[], front: Range | null, occupy: { from: number; to: number }[]): void {
  let defs: Map<string, string> | null = null
  const definitions = (): Map<string, string> => (defs ??= linkReferenceDefinitions(state, front))

  iterateContent(state, front, (node) => {
    // 引用式链接 / 脚注的定义行：压淡成一行「定义」，不再是夹在正文里的一串方括号。
    // 不整个藏掉——藏了用户就看不到自己写过什么（与脚注定义同一条规矩）。
    if (node.name === 'LinkReference') {
      const label = node.node.getChild('LinkLabel')
      const isFootnote = !!label && state.doc.sliceString(label.from, label.from + 2) === '[^'
      // 脚注定义（`[^1]: 说明`）由脚注那一节压淡，这里只管链接定义
      if (!isFootnote) pushBlockLines(state, node.from, Math.max(node.from, node.to - 1), 'cm-md-linkdef', ranges)
      return false
    }
    // 自动链接 `<https://…>`、`<a@b.com>`：尖括号只是指令，地址本身就是链接文字
    if (node.name === 'Autolink') {
      const url = node.node.getChild('URL')
      if (!url) return false
      const href = state.doc.sliceString(url.from, url.to)
      const isMail = !/^[a-z][a-z0-9+.-]*:/i.test(href)
      // 光标在这条自动链接上（或紧贴两端）时尖括号压淡显形
      const shown = constructRevealed(state, node.node)
      for (const mark of node.node.getChildren('LinkMark')) {
        ranges.push({ from: mark.from, to: mark.to, deco: shown ? MARK({ class: 'cm-md-marker' }) : hide(mark.from, mark.to) })
      }
      occupy.push({ from: node.from, to: node.to })
      ranges.push({
        from: url.from,
        to: url.to,
        deco: MARK({ class: 'cm-md-link', attributes: { 'data-href': isMail ? `mailto:${href}` : href } }),
      })
      return false
    }
    if (node.name !== 'Link') return
    // 光标在链接文字里：整条 `[文字](地址)` 按源码显示，就地改
    if (constructRevealed(state, node.node)) return false
    const url = node.node.getChild('URL')
    const label = node.node.getChild('LinkLabel')
    let href: string
    let textTo: number
    if (url) {
      // 行内链接 `[文字](地址 "标题")`
      const head = state.doc.sliceString(node.from, url.from)
      const cut = head.lastIndexOf('](')
      if (cut < 1) return false
      textTo = node.from + cut
      if (textTo <= node.from + 1) return false
      href = state.doc.sliceString(url.from, url.to)
    } else {
      // 引用式链接 `[文字][id]` / `[文字][]` / `[文字]`：地址在文档别处的定义里。
      // 脚注 `[^1]` 也是这个形状，交给脚注那一节画。
      const isFootnote = state.doc.sliceString(node.from + 1, Math.min(node.to, node.from + 2)) === '^'
        || (!!label && state.doc.sliceString(label.from + 1, Math.min(label.to, label.from + 2)) === '^')
      if (isFootnote) return false
      const text = state.doc.sliceString(node.from, label ? label.from : node.to)
      const close = text.lastIndexOf(']')
      if (close < 1) return false
      textTo = node.from + close
      const labelText = label
        ? state.doc.sliceString(label.from + 1, label.to - 1)
        : state.doc.sliceString(node.from + 1, textTo)
      const defined = definitions().get(normalizeLinkLabel(labelText))
      // 没有对应定义就不是链接（CommonMark 判它为普通文字），保持原样
      if (defined === undefined) return false
      href = defined
    }
    // 查找的当前项落在藏起来的那部分里（开头的 `[`，或 `](地址)` 那一截）：整条退回源码，
    // 高亮才落得到看得见的文字上（地址在渲染模式下是不显示的）
    if (searchCurrentIn(state, node.from, node.from + 1) || searchCurrentIn(state, textTo, node.to)) return false
    occupy.push({ from: node.from, to: node.to })
    ranges.push({ from: node.from, to: node.from + 1, deco: hide(node.from, node.from + 1) })
    ranges.push({ from: textTo, to: node.to, deco: hide(textTo, node.to) })
    ranges.push({
      from: node.from + 1,
      to: textTo,
      deco: MARK({ class: 'cm-md-link', attributes: { 'data-href': href } }),
    })
    return false
  })
}

// ─── 脚注 ────────────────────────────────────────────────────────────────────
//
// 引用画成上标数字，定义行压淡。悬停预览的卡片在 editor.ts 里（那是交互，不是装饰）。

class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly index: number,
  ) {
    super()
  }

  eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label && other.index === this.index
  }

  toDOM(): HTMLElement {
    const sup = document.createElement('sup')
    sup.className = 'cm-md-footnote-ref'
    sup.setAttribute('data-footnote', this.label)
    sup.textContent = String(this.index)
    return sup
  }
}

function collectFootnotes(
  state: EditorState,
  text: string,
  ranges: DecorationRange[],
  front: Range | null,
  extras: RevealExtra[] = [],
): void {
  const numbers = footnoteNumbers(text)
  const definitions = footnoteDefinitions(text)

  // 引用：整段 `[^note]` 换成上标数字
  FOOTNOTE_REF_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FOOTNOTE_REF_RE.exec(text)) !== null) {
    const from = match.index
    const to = from + match[0].length
    if (front && inRange(front, from)) continue
    if (definitions.has(match[1]) === false && numbers.has(match[1]) === false) continue
    // 定义行行首的标签（`[^1]: 说明`）不是引用：留着原文，整行压淡（下面的定义行分支）。
    // 以前它也被换成上标数字，定义行读起来是「¹: 说明」——与「定义行压淡、不隐藏」
    // 的本意相反（2026-11-23 加脚注命令时查出来的）。正文里紧跟冒号的引用不受影响。
    const line = state.doc.lineAt(from)
    if (text[to] === ':' && from - line.from <= 3 && /^\s*$/.test(line.text.slice(0, from - line.from))) continue
    // 光标在这条脚注引用上（或紧贴两端）时不换成上标数字，源码 `[^note]` 就地可改；
    // 查找的当前项落在它里面时同样退回源码（上标数字里没有这段文字，高亮落不上去）
    extras.push({ from, to })
    if (within(state, from, to) || searchCurrentIn(state, from, to)) continue
    ranges.push({
      from,
      to,
      deco: Decoration.replace({ widget: new FootnoteRefWidget(match[1], numbers.get(match[1]) ?? 1) }),
    })
  }

  // 定义行：压淡，不隐藏（隐藏了用户就看不到自己写了什么）
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (!/^ {0,3}\[\^[^\]\s]+\]:/.test(line.text)) continue
    if (front && inRange(front, line.from)) continue
    ranges.push({ from: line.from, to: line.from, deco: BLOCK('cm-md-footnote-def') })
  }
}

// ─── HTML ────────────────────────────────────────────────────────────────────
//
// 文件里的 HTML 照原样画出来，但先过一遍消毒（见 html-sanitize.ts）。
// 画不出来就退回源码：和公式、mermaid 一样的规矩。

class HTMLWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly block: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }

  eq(other: HTMLWidget): boolean {
    return other.source === this.source && other.block === this.block && other.from === this.from && other.to === this.to
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement(this.block ? 'div' : 'span')
    wrap.className = this.block ? 'cm-md-html cm-md-html-block' : 'cm-md-html cm-md-html-inline'
    withSourceRange(wrap, this.from, this.to)
    wrap.appendChild(sanitizeHTML(this.source))
    return wrap
  }
}

function collectHTML(
  state: EditorState,
  ranges: DecorationRange[],
  front: Range | null,
  zones: ActiveZone[],
  occupy: { from: number; to: number }[] = [],
  extras: RevealExtra[] = [],
): void {
  // 成对的行内标签一起处理：闭标签的起点记下来，轮到它时就跳过
  const paired = new Set<number>()
  iterateContent(state, front, (node) => {
    // 行首起的 HTML 注释是块级的 CommentBlock（连同同一行上 `-->` 之后的文字）；
    // 交给消毒器：注释被丢掉，后面的文字照常显示。段落中间的注释由 collectInline 藏掉。
    const block = node.name === 'HTMLBlock' || node.name === 'CommentBlock'
    if (!block && node.name !== 'HTMLTag') return
    // `<img>` 标签交给 collectImages 当图片画（相对路径按文档地址解析、可以缩放），
    // 不走这里的「光标进块就露源码」
    if (node.name !== 'CommentBlock' && IMG_TAG_RE.test(state.doc.sliceString(node.from, node.to).trim())) return false
    if (block) {
      zones.push({ from: node.from, to: node.to, kind: 'block' })
      // 块级 HTML：光标在块里就退回源码；查找的当前项落在块里时也退回源码——
      // 画出来的 HTML 里没有缓冲区那段文字，高亮只能落在看得见的源码上
      if (isBlockActive(state, node.from, node.to) || searchCurrentIn(state, node.from, node.to)) return false
    }
    if (!block) {
      if (paired.has(node.from)) return false
      const tag = parseHtmlTag(state.doc.sliceString(node.from, node.to))
      const close = tag && !tag.closing && !tag.selfClosing && !HTML_VOID.has(tag.name)
        ? matchingCloseTag(node.node, tag.name, state)
        : null
      if (tag && close) {
        paired.add(close.from)
        const styleAttr = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag.attrs)
        const style = styleAttr ? cleanStyle(styleAttr[1] ?? styleAttr[2] ?? '') : ''
        const otherAttrs = tag.attrs.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/i, '').trim()
        const semantic = HTML_SEMANTIC[tag.name]
        // 光标在这对标签里（或紧贴两头）时两头的标签压淡显形，与强调的边界规则一致。
        // 区间与 extras 里记的必须是同一个，重算门才问得出同一个答案。
        const shown = within(state, node.from, close.to)
        extras.push({ from: node.from, to: close.to })
        const tagDeco = shown ? MARK({ class: 'cm-md-marker' }) : null
        if (!semantic && otherAttrs) {
          // 带其它属性（class / href / color…）的标签没法用「藏标签 + 加样式」表达：
          // 整段画成真 HTML（消毒后）。里面的 markdown 不再解析——这是 HTML，本该如此。
          occupy.push({ from: node.from, to: close.to })
          if (tagDeco) {
            // 披露时只显示源码文字（两头的标签压淡），不画 widget
            ranges.push({ from: node.from, to: node.to, deco: tagDeco })
            ranges.push({ from: close.from, to: close.to, deco: tagDeco })
          } else {
            ranges.push({
              from: node.from,
              to: close.to,
              deco: Decoration.replace({ widget: new HTMLWidget(state.doc.sliceString(node.from, close.to), false, node.from, close.to) }),
            })
          }
          return false
        }
        // 语义标签（<u>、<b>、<sub>…）：藏掉两头的标签，给中间那段文字加对应的样式。
        // 中间仍是普通的 markdown 文字，里面的加粗、链接、公式照常渲染。
        occupy.push({ from: node.from, to: node.to })
        occupy.push({ from: close.from, to: close.to })
        ranges.push({ from: node.from, to: node.to, deco: tagDeco ?? hide(node.from, node.to) })
        ranges.push({ from: close.from, to: close.to, deco: tagDeco ?? hide(close.from, close.to) })
        if (close.from > node.to && (semantic || style)) {
          ranges.push({
            from: node.to,
            to: close.from,
            deco: MARK(semantic
              ? { class: `cm-md-html-${semantic}`, ...(style ? { attributes: { style } } : {}) }
              : { attributes: { style } }),
          })
        }
        return false
      }
    }
    occupy.push({ from: node.from, to: node.to })
    ranges.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new HTMLWidget(state.doc.sliceString(node.from, node.to), block, node.from, node.to) }),
    })
    return false
  })
}

/** 在同一个块里找开标签对应的闭标签（同名标签正确计数嵌套）。 */
function matchingCloseTag(open: SyntaxNode, name: string, state: EditorState): SyntaxNode | null {
  let depth = 1
  for (let sibling = open.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (sibling.name !== 'HTMLTag') continue
    const tag = parseHtmlTag(state.doc.sliceString(sibling.from, sibling.to))
    if (!tag || tag.name !== name) continue
    if (tag.closing) {
      depth--
      if (depth === 0) return sibling
    } else if (!tag.selfClosing) {
      depth++
    }
  }
  return null
}

// ─── 代码块的复制按钮 ────────────────────────────────────────────────────────

/**
 * 代码块右上角的「复制」。
 *
 * 做成 widget 而不是事后往 DOM 里插一个按钮：CM6 会按自己的状态重建 DOM，
 * 手工插进去的节点随时会被抹掉（旧核心为此专门把按钮放在编辑器 DOM 之外，
 * 还得跟着滚动重新定位）。widget 由 CM6 自己管，位置、滚动、重建都不用操心。
 */
class CodeCopyWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }

  eq(other: CodeCopyWidget): boolean {
    return other.code === this.code
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy-btn'
    button.textContent = isChinese() ? '复制' : 'Copy'
    button.setAttribute('data-code', this.code)
    button.contentEditable = 'false'
    return button
  }

  ignoreEvent(): boolean {
    // 让点击落到按钮自己身上，而不是被编辑器当成「放置光标」
    return false
  }
}

/** 围栏里的代码：去掉开头那一行（` ```lang `）与收尾那一行。 */
function codeInsideFence(state: EditorState, node: SyntaxNodeRef): string {
  const startLine = state.doc.lineAt(node.from).number
  const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
  if (endLine - startLine < 2) return ''
  const lines: string[] = []
  for (let n = startLine + 1; n < endLine; n++) lines.push(state.doc.line(n).text)
  return lines.join('\n')
}

// ─── 图片 ────────────────────────────────────────────────────────────────────

function collectImages(
  state: EditorState,
  ranges: DecorationRange[],
  front: Range | null,
  /** 图片区间要避开的地方：宽松强调不许往里补画（图片退回源码时地址要原样可见）。 */
  occupy?: { from: number; to: number }[],
  /** 整段被换成 widget 的区间，高亮 `==` 不许跨过去配对。 */
  opaque?: { from: number; to: number }[],
  /** 可披露的构造（见 revealKeyOf）：`<img>` 标签不在语法树的 Image 节点里，要单独记。 */
  extras?: RevealExtra[],
): void {
  const base = state.field(documentFileUrlField, false) ?? documentFileUrl
  const push = (from: number, to: number, src: string, alt: string, width: number, html: boolean): boolean => {
    occupy?.push({ from, to })
    opaque?.push({ from, to })
    // 光标在图片源码的开头就退回源码：改路径就是改文字（见 constructRevealed）；
    // 查找的当前项落在图片源码里时也退回源码——画出来的图里没有这段文字可高亮
    if (within(state, from, to - 1) || searchCurrentIn(state, from, to)) return false
    const source = state.doc.sliceString(from, to)
    ranges.push({
      from,
      to,
      deco: Decoration.replace({ widget: new ImageWidget(resolveImageSrc(src, base), alt, source, from, to, width, html) }),
    })
    return false
  }
  iterateContent(state, front, (node) => {
    // ColaMD CT（2026-11-24）：`<img …>` 标签也是图片。缩放过的图片是这个写法（见
    // shared/image-syntax）；以前它被当成普通行内 HTML，相对路径不按文档地址解析，
    // 本地图片整个显示不出来。
    if (node.name === 'HTMLTag' || node.name === 'HTMLBlock') {
      const raw = state.doc.sliceString(node.from, node.to)
      if (!IMG_TAG_RE.test(raw.trim())) return
      const tag = raw.trim()
      const from = node.from + raw.length - raw.trimStart().length
      const to = from + tag.length
      const width = Number.parseInt(imgAttr(tag, 'width') ?? '', 10)
      extras?.push({ from, to })
      return push(from, to, imgAttr(tag, 'src') ?? '', imgAttr(tag, 'alt') ?? '', width > 0 ? width : 0, true)
    }
    if (node.name !== 'Image') return
    const source = state.doc.sliceString(node.from, node.to)
    const parsed = parseImage(source)
    if (!parsed) return false
    return push(node.from, node.to, parsed.src, parsed.alt, 0, false)
  })
}

// ─── 引用块与分隔线 ──────────────────────────────────────────────────────────

function collectBlocks(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  iterateContent(state, front, (node) => {
    switch (node.name) {
      case 'Blockquote': {
        pushBlockLines(state, node.from, node.to, 'cm-md-blockquote', ranges)
        break
      }
      case 'HorizontalRule': {
        // 行装饰：`---` 本身要藏起来，横线靠行的上边框画。
        // （属性区里的 `---` 是 YAML 的分隔符，已被 iterateContent 挡在外面）
        const lineFrom = state.doc.lineAt(node.from).from
        ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK('cm-md-hr') })
        // 分隔线不随光标披露：行上本来就只剩一条横线，再把 `---` 翻出来只会多出一行字
        ranges.push({ from: node.from, to: node.to, deco: hide(node.from, node.to) })
        break
      }
      case 'ListMark': {
        if (!hasListSpace(state, node.to)) break
        // 缩进只由一处分派：样式表按层级给左内边距（cm-md-li-N），所以源码里那几个
        // 空格在渲染模式下要藏起来。留着的话，排版是「CSS 缩进 + 源码空格」两份叠在
        // 一起：实测二级 56px、三级 88px，比旧引擎（每层 24px）多出三成，越深越夸张
        // （2026-11-07 橘子：「我不喜欢列表缩进那么多的排版…tab 之后，也太多了」）。
        // 引用里的列表跳过行首 `> `，那一段归 QuoteMark 自己藏，避免两份 replace 撞区间。
        const line = state.doc.lineAt(node.from)
        const quoteLen = QUOTE_PREFIX_RE.exec(state.doc.sliceString(line.from, node.from))?.[0].length ?? 0
        const hideFrom = line.from + quoteLen
        // 光标在标记上（或紧贴标记之后）时标记显形，可以就地改；光标在条目正文里时
        // 照常画成圆点 / 序号（见 constructRevealed）。光标停在子项的缩进里时缩进也一并
        // 显形——否则光标落在被藏掉的空格里，看不见自己在哪。
        const markShown = constructRevealed(state, node.node)
        if (node.from > hideFrom) {
          ranges.push({ from: hideFrom, to: node.from, deco: markShown ? MARK({ class: 'cm-md-marker' }) : hide(hideFrom, node.from) })
        }
        const raw = state.doc.sliceString(node.from, node.to).trim()
        // 待办项的圆点要去掉：它已经有复选框了，两个标记并排就是「• ☐ 文案」。
        const after = state.doc.sliceString(node.to, node.to + 4)
        if (/^\s+\[[ xX]\]/.test(after)) {
          hideMarker(state, node.from, node.to, ranges, markShown)
          break
        }
        // `-` / `*` / `+` 画成真的圆点；`1.` 这种照原样显示，序号就是文件里的字
        if (/^[-*+]$/.test(raw) && !markShown) {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new ListBulletWidget() }),
          })
        } else {
          ranges.push({ from: node.from, to: node.to, deco: MARK({ class: 'cm-md-listmark' }) })
        }
        break
      }
      // 列表项：整行加类，类名里带上嵌套层级，CSS 据此缩进。
      // CM6 没有 ul/ol/li 元素，缩进只能自己算；层级来自语法的嵌套深度。
      case 'ListItem': {
        pushListItemLines(state, node.node, ranges)
        break
      }
      case 'FencedCode': {
        // 右上角的复制按钮挂在第一行（围栏那一行）末尾，鼠标悬停代码块时才显形。
        // 导出态不加：导出的是一篇文档，不是编辑器此刻的样子。
        const code = exportingCleanly(state) ? '' : codeInsideFence(state, node)
        if (code !== '') {
          ranges.push({
            from: state.doc.lineAt(node.from).to,
            to: state.doc.lineAt(node.from).to,
            deco: Decoration.widget({ widget: new CodeCopyWidget(code), side: 1 }),
          })
        }
        const startLine = state.doc.lineAt(node.from)
        const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
        // 每一行都加底色，首行与末行额外加圆角，拼出一个代码块的外形
        for (let n = startLine.number; n <= endLine.number; n++) {
          const lineFrom = state.doc.line(n).from
          const cls = [
            'cm-md-codeblock',
            n === startLine.number ? 'cm-md-codeblock-first' : '',
            n === endLine.number ? 'cm-md-codeblock-last' : '',
          ].filter(Boolean).join(' ')
          ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK(cls) })
        }
        break
      }
      case 'QuoteMark': {
        // `>` 在光标不在这一行时藏起来（连它后面的空格），引用就该只看到竖线与文字
        // 例外：这一行除了 `>` 别的什么都没有。刚打出一个 `>` 就把它藏掉，屏幕上什么
        // 都不剩，得再打个空格才出现引用竖线（2026-11-07 与标题同一个毛病）。
        const rest = state.doc.sliceString(node.to, state.doc.lineAt(node.to).to)
        if (rest.trim() === '' || constructRevealed(state, node.node)) {
          ranges.push({ from: node.from, to: node.to, deco: MARK({ class: 'cm-md-quotemark' }) })
        } else {
          hideMarker(state, node.from, node.to, ranges)
        }
        break
      }
      // ColaMD CT（2026-11-23 全语法审计）：缩进代码块（四个空格起头的那种）此前
      // 完全没有代码块外观，就是一段带空格的正文。这里给它与围栏代码块同一套行类。
      case 'CodeBlock': {
        const firstLine = state.doc.lineAt(node.from)
        const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
        // 首行 node.from 之前的缩进 = 「这是代码」的指令宽度；其余行最多剥这么多
        const markerWidth = node.from - firstLine.from
        for (let n = firstLine.number; n <= lastLine.number; n++) {
          const line = state.doc.line(n)
          const cls = [
            'cm-md-codeblock',
            n === firstLine.number ? 'cm-md-codeblock-first' : '',
            n === lastLine.number ? 'cm-md-codeblock-last' : '',
          ].filter(Boolean).join(' ')
          ranges.push({ from: line.from, to: line.from, deco: BLOCK(cls) })
          const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0
          const strip = n === firstLine.number ? markerWidth : Math.min(indent, markerWidth)
          if (strip > 0) ranges.push({ from: line.from, to: line.from + strip, deco: hide(line.from, line.from + strip) })
        }
        break
      }
      default:
        break
    }
  })
}

// ─── 标题与行内格式 ──────────────────────────────────────────────────────────
//
// 节点名以实际语法树为准（用 node_modules/.cache/domcheck 验过，见 scripts/tmp-domcheck.mjs）：
//   ATXHeading1..6   标题
//   EmphasisMark     `*` 与 `**` 都用这个名字，没有单独的 StrongEmphasisMark
//   StrikethroughMark `~~`
//   CodeMark         行内代码的反引号
//   InlineCode       行内代码本体
//   URL              链接地址
/**
 * 裸链接（GFM autolink）的终点：中日韩文字与全角标点。
 *
 * 解析器只把空白当断点，所以中文冒号、句号后面的话会被一起吞进 URL，整段染成链接色。
 * 链接该在文字出现的地方结束。
 */
const URL_STOP = /[\u2E80-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/

/**
 * 强调类节点的样式区间。
 *
 * 定界符显形时（光标在这个构造里）只盖住中间的文字：显形的 `**` 是给人改的标记，
 * 压淡就好，不该跟着加粗、倾斜、划一条删除线（删除线尤其没法用样式撤掉——
 * text-decoration 会穿过行内子元素）。定界符藏着时照旧盖整个节点，外面的看不出来。
 * 两头不是标记节点（解析不出意料之外的形状）就退回整个区间。
 */
function styledRange(node: SyntaxNodeRef, revealed: boolean): { from: number; to: number } {
  const open = node.node.firstChild
  const close = node.node.lastChild
  if (revealed && open && close && open !== close && open.name === close.name && open.name.endsWith('Mark')) {
    return { from: open.to, to: close.from }
  }
  return { from: node.from, to: node.to }
}

function collectInline(
  state: EditorState,
  ranges: DecorationRange[],
  front: Range | null,
  occupy: { from: number; to: number }[],
  /** 被宽松层判成「语法树错配」而撤掉加粗的强调节点（按节点起点索引）。 */
  suppressed: Set<number>,
  /** 宽松层的修复配对：EmphasisMark 的显形要用它认「这一对正在披露」。 */
  repairs: readonly LoosePair[],
): void {
  // 修复配对按定界符起点建索引：光标落在修复对里时，被语法树藏掉的半个定界符也要显形
  const repairByMark = new Map<number, LoosePair>()
  for (const pair of repairs) {
    repairByMark.set(pair.openFrom, pair)
    repairByMark.set(pair.closeFrom, pair)
  }
  const repairRevealed = (markFrom: number): boolean => {
    const pair = repairByMark.get(markFrom)
    return !!pair && within(state, pair.from, pair.to)
  }
  iterateContent(state, front, (node) => {
      // 链接定义行整行压淡，里面的地址/标签不再单独上链接色
      if (node.name === 'LinkReference') return false
      const from = node.from
      const to = node.to

      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          // 行装饰：标题的字号属于整行，加在行上才撑得住行高
          // 只认「# + 空格」。CommonMark 把孤零零一个 `#` 也算成空标题，于是刚打出一个
          // `#`、空格还没落下，整行就先变成标题、`#` 还被藏起来：看起来像字打丢了，
          // 接着打字母又退回普通段落，一亮一灭（2026-11-07 报的「我还没点空格呢」）。
          // Typora 与 Obsidian 都是等空格出现才开始当标题。
          const head = state.doc.sliceString(from, state.doc.lineAt(from).to)
          if (!/^#{1,6}[ \t]/.test(head)) return false
          pushBlockLines(state, from, to, `cm-md-${node.name.toLowerCase()}`, ranges)
          break
        }
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark': {
          occupy.push({ from, to })
          const fence = node.node.parent
          // 整块 Mermaid 替换与围栏空替换同起点时，增量更新会只留下空块。
          if (node.name === 'CodeMark' && fence?.name === 'FencedCode' &&
              !mermaidSourceShown(state, fence.from, fence.to) &&
              /^(`{3,}|~{3,})\s*mermaid\s*$/.test(state.doc.sliceString(fence.from, state.doc.lineAt(fence.from).to).trim()) &&
              codeInsideFence(state, fence).trim()) break
          // 光标在这个构造里（或紧贴两端）时标记压淡显形（见 constructRevealed）。
          // 围栏代码块本身不在可披露之列——光标在代码块里时 ``` 不该跟着显形。
          // 错配修复对（宽松层）的半个定界符也归这里藏：光标落进修复对里时它同样要显形。
          const shown = constructRevealed(state, node.node.parent!)
            || (node.name !== 'CodeMark' && repairRevealed(from))
          ranges.push({ from, to, deco: shown ? MARK({ class: 'cm-md-marker' }) : hide(from, to) })
          break
        }
        case 'CodeInfo': {
          // 围栏上的语言名（```js 里的 js）。压淡，让它读起来是标注而不是代码。
          ranges.push({ from, to, deco: MARK({ class: 'cm-md-codeinfo' }) })
          break
        }
        case 'HeaderMark': {
          // Setext 标题（`===` / `---` 下划线）的下划线行由下面的 Setext 分支整行处理
          if (node.node.parent?.name.startsWith('Setext')) break
          // 标题的 `#` 连同后面那个空格一起藏，否则标题会比正文右移一个字；
          // 光标在行首（标记上或紧贴其后）时显形，可以就地改标题级别
          const shown = constructRevealed(state, node.node)
          // 标题前的缩进（CommonMark 允许最多三格）与 `#` 同进退：藏着时一起藏——渲染好的
          // 标题不该带着源码里的空格；显形时一起露，看到的就是源码原文。
          // `#` 前面不全是空白的不碰（`> # 标题`、`- # 标题`），那一段归引用标记 / 列表标记。
          const lineFrom = state.doc.lineAt(from).from
          if (!shown && from > lineFrom && state.doc.sliceString(lineFrom, from).trim() === '') {
            ranges.push({ from: lineFrom, to: from, deco: hide(lineFrom, from) })
          }
          hideMarker(state, from, to, ranges, shown)
          break
        }
        // ColaMD CT（2026-11-23 全语法审计）：下面这些节点此前渲染层完全没有处理，
        // 源码里的指令字符（反斜杠、&amp; 之类）原样露在正文里。
        case 'SetextHeading1':
        case 'SetextHeading2': {
          // `标题` 下一行划 `===` / `---` 也是标题，与 # 标题同一套字号
          const mark = node.node.getChild('HeaderMark')
          const textTo = mark ? state.doc.lineAt(mark.from - 1).to : to
          pushBlockLines(state, from, textTo, node.name === 'SetextHeading1' ? 'cm-md-atxheading1' : 'cm-md-atxheading2', ranges)
          if (mark) {
            // 下划线那一行整行收成零高，标题与下文之间不留一道空白
            const markLine = state.doc.lineAt(mark.from)
            ranges.push({ from: markLine.from, to: markLine.from, deco: BLOCK('cm-md-collapsed') })
            ranges.push({ from: markLine.from, to: markLine.to, deco: hide(markLine.from, markLine.to) })
          }
          break
        }
        case 'Escape': {
          // `\*` `\_` `\#`：反斜杠只是「下一个字符取字面」的指令，藏掉它；
          // 光标紧挨着它时压淡显形
          occupy.push({ from, to: from + 1 })
          ranges.push({ from, to: from + 1, deco: constructRevealed(state, node.node) ? MARK({ class: 'cm-md-marker' }) : hide(from, from + 1) })
          break
        }
        case 'HardBreak': {
          // 硬换行：行尾的两个空格或反斜杠不显示（换行由每一行各是一个块保证）
          const lineTo = state.doc.lineAt(from).to
          if (Math.min(to, lineTo) > from) ranges.push({ from, to: Math.min(to, lineTo), deco: hide(from, Math.min(to, lineTo)) })
          break
        }
        case 'Entity': {
          // `&amp;` `&#65;` 解码成字符；不认识的实体（&nope;）按规范保持原样
          const decoded = decodeEntity(state.doc.sliceString(from, to))
          if (decoded !== null) {
            occupy.push({ from, to })
            ranges.push({ from, to, deco: Decoration.replace({ widget: new TextWidget(decoded) }) })
          }
          break
        }
        case 'Comment': {
          // HTML 注释不显示
          occupy.push({ from, to })
          ranges.push({ from, to, deco: hide(from, to) })
          break
        }
        case 'InlineCode': {
          occupy.push({ from, to })
          // 反引号显形时同样只给中间的文字上代码样式：标记一律是压淡的普通字
          const inner = styledRange(node.node, constructRevealed(state, node.node))
          ranges.push({ from: inner.from, to: inner.to, deco: MARK({ class: 'cm-md-inlinecode' }) })
          // CommonMark：内容两端同时是空格（且不全是空格）时各剥掉一格，
          // 否则 `` ` 带空格 ` `` 会比 `` `带空格` `` 多出两头空白
          const firstMark = node.node.firstChild
          const lastMark = node.node.lastChild
          if (firstMark && lastMark && firstMark.name === 'CodeMark' && lastMark.name === 'CodeMark' && lastMark.from > firstMark.to) {
            const content = state.doc.sliceString(firstMark.to, lastMark.from)
            if (content.length >= 2 && /^\s/.test(content[0]) && /\s$/.test(content[content.length - 1]) && content.trim() !== '') {
              const last = lastMark.from - 1
              ranges.push({ from: firstMark.to, to: firstMark.to + 1, deco: hide(firstMark.to, firstMark.to + 1) })
              ranges.push({ from: last, to: last + 1, deco: hide(last, last + 1) })
            }
          }
          break
        }
        // 三个强调类节点共用一条规矩：被宽松层判成「错配」的（suppressed）不上样式，
        // 定界符照旧由 EmphasisMark 分支藏掉，正文由宽松层的修复配对重新加粗
        case 'StrongEmphasis': {
          occupy.push({ from, to })
          if (suppressed.has(from)) break
          const inner = styledRange(node.node, constructRevealed(state, node.node))
          ranges.push({ from: inner.from, to: inner.to, deco: MARK({ class: 'cm-md-strong' }) })
          break
        }
        case 'Emphasis': {
          occupy.push({ from, to })
          if (suppressed.has(from)) break
          const inner = styledRange(node.node, constructRevealed(state, node.node))
          ranges.push({ from: inner.from, to: inner.to, deco: MARK({ class: 'cm-md-em' }) })
          break
        }
        case 'Strikethrough': {
          occupy.push({ from, to })
          if (suppressed.has(from)) break
          const inner = styledRange(node.node, constructRevealed(state, node.node))
          ranges.push({ from: inner.from, to: inner.to, deco: MARK({ class: 'cm-md-strike' }) })
          break
        }
        case 'URL': {
          // 解析器只把空白当断点，`https://example.com/a：后面还有` 整段都会被当成 URL。
          // 一打中文冒号，后半行就染成链接色、格式看着像丢了（2026-11-07 报的「点冒号
          // 的时候，后面的格式就丢了」）。Typora 与 Obsidian 都停在中文和全角标点处，
          // 所以这里把链接切到第一个中日韩字符或全角标点之前。
          const raw = state.doc.sliceString(from, to)
          const stop = raw.search(URL_STOP)
          const end = stop < 0 ? to : from + stop
          if (end > from) ranges.push({ from, to: end, deco: MARK({ class: 'cm-md-url' }) })
          break
        }
        default:
          break
    }
  })
}

// ─── 宽松强调（ColaMD CT 方言开关）──────────────────────────────────────────
//
// 只补画**严格 CommonMark 拒配**的成对标记。实测（scripts/verify-markdown-syntax.mjs）
// 严格规则在中文里的真实失效面是两类：
//   1. 内容边缘是全角标点、后面紧跟文字：`**“他说”**然后`
//   2. 下划线 `__` / `_` 紧贴汉字：`前__加粗__后`（CommonMark 的词内规则把汉字也算词字符）
// 这里只剩两条判定（Typora 手感）：
//   开侧：定界符后一个字符不是空白
//   闭侧：定界符前一个字符不是空白
// `_`/`__` 额外保留「词内不生效」，但只看 ASCII 词字符（snake_case_name 不许变斜体）。
//
// 扫描以**段落**为单位而不是以行：加粗跨软换行是最常见的写法
// （`上的**分布式\n平台（Socket）**向程序`），逐行扫永远找不到这一对。
// 引用标记（`> `）与列表缩进是块结构不是段落文字，拼逻辑文本时去掉，并保留
// 「逻辑位置 → 文档位置」的映射，装饰最终落在文档位置上。
// 补画对：被语法树认领的区间（occupy：合法强调/代码/链接/公式/高亮/HTML）相交就不画，
// 绝不双画；反斜杠转义的定界符（`\*`）也不算定界符。缓冲区字节不动。
// 修复对（v2.7.21）：语法树把定界符**错配**走时（见 analyzeEmphasisRepair）例外，
// 只在定界符上与错配节点相交、内容干净——照画，并撤掉错配节点的加粗。

/** 宽松层要扫的「段落」：正文段落 + 标题文字部分 + 表格的每一格。 */
function collectParagraphs(state: EditorState, front: Range | null): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  iterateContent(state, front, (node) => {
    if (node.name === 'Paragraph') out.push({ from: node.from, to: node.to })
    // 标题里的强调同样要走宽松补画（只取文字部分，不含 # 与下划线）
    if (/^ATXHeading[1-6]$/.test(node.name)) out.push({ from: node.from, to: node.to })
    if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
      const mark = node.node.getChild('HeaderMark')
      if (mark) out.push({ from: node.from, to: mark.from - 1 })
    }
    // ColaMD CT（2026-11-24）：光标落进表格时整块退回源码，格子里的文字由装饰层来画。
    // 以前这里没有表格，`**“这个”**` 在渲染好的表格里是粗体，光标一进表格就掉回普通字
    // （看着像「点一下表格格式就没了」）。一格算一段：不跨管子配对，与格子渲染器的规矩一致。
    if (node.name === 'Table') {
      let at = node.from
      for (const line of state.doc.sliceString(node.from, node.to).split('\n')) {
        for (const cell of rowCellRanges(line)) out.push({ from: at + cell.from, to: at + cell.to })
        at += line.length + 1
      }
    }
  })
  return out
}

/** 表格源码的一行里各个格子的文字区间（行内下标，去掉管子与首尾空白）。 */
function rowCellRanges(line: string): { from: number; to: number }[] {
  const cells: { from: number; to: number }[] = []
  let start = -1
  for (let i = 0; i <= line.length; i++) {
    const char = line[i]
    if (char === '\\' && line[i + 1] === '|') {
      i++
      continue
    }
    if (char === '|' || char === undefined) {
      if (start >= 0) cells.push({ from: start, to: i })
      start = -1
    } else if (start < 0 && char !== ' ' && char !== '\t') {
      start = i
    }
  }
  return cells
}

// `_` 的词内防误伤只看 ASCII 词字符（snake_case_name 不能变斜体）；
// 汉字不算（`前__加粗__后` 要能渲染——严格 CommonMark 恰恰是这批 `__` 写法
// 在中文里全灭，宽松层的存在意义）。
const LOOSE_WORD_CHAR = /[A-Za-z0-9_]/

interface LoosePairSpec {
  delim: string
  cls: string
  wordGuard: boolean
  /** 夹在中间的内容必须满足它才算一对（上下标的防误伤，见 SCRIPT_SPECS）。 */
  content?: RegExp
}

const SCRIPT_CONTENT = /^[A-Za-z0-9+-]{1,10}$/

const LOOSE_SPECS: LoosePairSpec[] = [
  { delim: '**', cls: 'cm-md-strong', wordGuard: false },
  { delim: '__', cls: 'cm-md-strong', wordGuard: true },
  { delim: '~~', cls: 'cm-md-strike', wordGuard: false },
  { delim: '*', cls: 'cm-md-em', wordGuard: false },
  { delim: '_', cls: 'cm-md-em', wordGuard: true },
  // Typora 的上下标写法：`x^2^`、`H~2~O`（2026-11-24 用户让排查漏掉的格式时补上）。
  // 中间只认短短一串 ASCII 字母数字：`5~10天，7~12天`、`pH7~14和20~30` 这类区间写法
  // 才不会被当成下标。单个 `~` 只在前后都不是 `~` 时才算定界符，删除线 `~~x~~` 不受影响。
  { delim: '^', cls: 'cm-md-html-sup', wordGuard: false, content: SCRIPT_CONTENT },
  { delim: '~', cls: 'cm-md-html-sub', wordGuard: false, content: SCRIPT_CONTENT },
]
/** 宽松扫描里的一个候选配对（文档绝对坐标）。 */
interface LoosePair {
  /** 配对整段 [from, to)。 */
  from: number
  to: number
  /** 开侧定界符 [openFrom, openFrom + d)；闭侧 [closeFrom, closeFrom + d)。 */
  openFrom: number
  closeFrom: number
  delim: string
  d: number
  cls: string
  /** 开/闭侧定界符与语法树里某个强调节点的标记重合时的节点下标，否则 -1。 */
  openClaim: number
  closeClaim: number
  /** 两侧被同一个节点认领：语法树本来就是这么配的，不归宽松层管。 */
  sameNode: boolean
  /** 至少一侧被**别的配对**的标记认领：语法树把定界符错配走了，这一对是修复。 */
  repair: boolean
}

/** 语法树里的强调节点（含删除线）。宽松层据此区分「补画」与「修复」。 */
interface EmphasisNode {
  from: number
  to: number
  openMark: { from: number; to: number } | null
  closeMark: { from: number; to: number } | null
}

function collectEmphasisNodes(state: EditorState, front: Range | null): EmphasisNode[] {
  const out: EmphasisNode[] = []
  iterateContent(state, front, (node) => {
    if (node.name !== 'StrongEmphasis' && node.name !== 'Emphasis' && node.name !== 'Strikethrough') return
    const markEdge = (edge: SyntaxNode | null): { from: number; to: number } | null =>
      edge && edge.name.endsWith('Mark') && edge.from < edge.to ? { from: edge.from, to: edge.to } : null
    out.push({ from: node.from, to: node.to, openMark: markEdge(node.node.firstChild), closeMark: markEdge(node.node.lastChild) })
  })
  return out
}

/** 定界符起点 → 它是哪个节点的哪一侧标记。 */
function markClaimIndex(emphasis: EmphasisNode[]): Map<number, { node: number; side: 'open' | 'close'; len: number }> {
  const index = new Map<number, { node: number; side: 'open' | 'close'; len: number }>()
  emphasis.forEach((node, i) => {
    if (node.openMark) index.set(node.openMark.from, { node: i, side: 'open', len: node.openMark.to - node.openMark.from })
    if (node.closeMark) index.set(node.closeMark.from, { node: i, side: 'close', len: node.closeMark.to - node.closeMark.from })
  })
  return index
}

/**
 * 段落的「逻辑文本」：剥掉续行的引用标记与缩进，保留 逻辑位置 → 文档位置 的映射。
 * 配对的枚举与绘制共用这一份。
 */
function logicalParagraph(state: EditorState, para: { from: number; to: number }): { text: string; map: number[] } {
  const map: number[] = []
  let text = ''
  let lineStart = para.from
  while (lineStart <= para.to) {
    const lineEnd = Math.min(state.doc.lineAt(lineStart).to, para.to)
    const line = state.doc.sliceString(lineStart, lineEnd)
    // 首行从节点起点开始（引用/列表标记不在节点内）；续行要剥掉行首的引用标记与缩进
    let strip = 0
    if (lineStart > para.from) {
      const quote = QUOTE_PREFIX_RE.exec(line)?.[0].length ?? 0
      const indent = /^[ \t]*/.exec(line.slice(quote))?.[0].length ?? 0
      strip = quote + indent
    }
    for (let j = strip; j < line.length; j++) {
      map.push(lineStart + j)
      text += line[j]
    }
    if (lineEnd < para.to) {
      text += '\n'
      map.push(lineEnd)
      lineStart = lineEnd + 1
    } else {
      break
    }
  }
  return { text, map }
}

/**
 * 按宽松规则枚举一段里的全部候选配对（Typora 手感：开侧后一字符非空白、闭侧前一字符
 * 非空白、`_` 词内不生效），每个开侧配**最近的**合法闭侧。
 *
 * onPair 收到每个候选，返回值只用于调用方记账；枚举的推进与返回值无关——
 * 这样「分析」（决定撤掉哪些错配）与「绘制」（真去画）看到的是同一串候选，永远一致。
 *
 * 闭侧候选预计算 + 二分找最近闭侧：落单的开侧（`**x**` 的后一个 `*` 对单 `*` 规则而言）
 * 以前会把整段扫到头，不空行的长文里是平方级（1500 行的段落每次重算 170ms，
 * 2026-11-23 量出来的）。闭侧合不合法只看它自己的位置，与开侧无关，所以可以一次列出来。
 */
function enumerateLoosePairs(
  text: string,
  map: number[],
  claims: Map<number, { node: number; side: 'open' | 'close'; len: number }>,
  onPair: (pair: LoosePair) => boolean,
): void {
  // 前面紧挨着奇数个反斜杠 = 被转义的定界符（`\*`），不算定界符
  const escaped = (index: number): boolean => {
    let backslashes = 0
    for (let k = index - 1; k >= 0 && text[k] === '\\'; k--) backslashes++
    return backslashes % 2 === 1
  }
  const claimAt = (pos: number, d: number): number => {
    const hit = claims.get(pos)
    return hit && hit.len === d ? hit.node : -1
  }

  for (const spec of LOOSE_SPECS) {
    const d = spec.delim.length
    const head = spec.delim[0]
    const closers: number[] = []
    for (let j = 0; j + d <= text.length; j++) {
      if (text[j] !== head || !text.startsWith(spec.delim, j)) continue
      if (text[j - 1] === head || escaped(j)) continue
      if (j + d < text.length && text[j + d] === head) continue
      if (/\s/.test(text[j - 1])) continue
      if (spec.wordGuard && j + d < text.length && LOOSE_WORD_CHAR.test(text[j + d])) continue
      closers.push(j)
    }
    let i = 0
    while (i + d <= text.length) {
      // 开侧不能是 `**` 的后半截（`**加粗**和*斜体*` 里的第二个 `*` 不是斜体的开侧）：
      // 与闭侧「不能是定界符串的尾巴」对称。以前漏了这一半，那个候选一直存在，只是
      // 被 occupy 挡着没露出过；修复对绕过 occupy 之后它就冒出来了（2026-11-23 回归里抓到的）。
      if (text[i] !== head || text[i - 1] === head || !text.startsWith(spec.delim, i) || text[i + d] === head || escaped(i)) { i++; continue }
      // 开侧：后一个字符存在且不是空白（含换行）
      if (i + d >= text.length || /\s/.test(text[i + d])) { i++; continue }
      // `_` 词内不生效：前一个字符是 ASCII 词字符就不当开侧
      if (spec.wordGuard && i > 0 && LOOSE_WORD_CHAR.test(text[i - 1])) { i++; continue }
      // 最近的合法闭侧：候选里第一个落在开侧之后的（可跨软换行）
      let lo = 0
      let hi = closers.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (closers[mid] < i + d + 1) lo = mid + 1
        else hi = mid
      }
      if (lo >= closers.length) { i++; continue }
      // 有内容要求的（上下标）：这一个闭侧夹出来的内容不合格，就往后找下一个闭侧
      let close = closers[lo]
      while (spec.content && !spec.content.test(text.slice(i + d, close))) {
        lo++
        if (lo >= closers.length || closers[lo] - i > 12) break
        close = closers[lo]
      }
      if (spec.content && !spec.content.test(text.slice(i + d, close))) { i++; continue }
      const openFrom = map[i]
      const closeFrom = map[close]
      const openClaim = claimAt(openFrom, d)
      const closeClaim = claimAt(closeFrom, d)
      const sameNode = openClaim >= 0 && openClaim === closeClaim
      onPair({
        from: openFrom,
        to: closeFrom + d,
        openFrom,
        closeFrom,
        delim: spec.delim,
        d,
        cls: spec.cls,
        openClaim,
        closeClaim,
        sameNode,
        repair: !sameNode && (openClaim >= 0 || closeClaim >= 0),
      })
      i = close + d
    }
  }
}

/**
 * 错配修复分析（宽松方言专用）。要在 collectInline **之前**跑——撤不撤某个节点的加粗、
 * 它的定界符要不要跟着修复对显形，都是画的时候就要知道的事。
 *
 * 背景（2026-11-23 用户报的「一句话里两个加粗，中间被加粗、外层星号成了普通字」）：
 * 加粗内容以全角标点开头/结尾时（`**“这个”**和**“那个”**`），CommonMark 的侧翼规则
 * 判定「紧跟 `“` 的 `**` 不能当开侧、前面是 `”` 的不能当闭侧」，于是语法树把中间那对
 * `**` 配成了强调，外层四个星号成了普通文字。加个空格就能恢复侧翼资格，所以
 * 「这句话里加个空格才能正常渲染」。
 *
 * 修法：宽松枚举按 Typora 规则本来就会把外层配成对；只要某个候选的定界符**恰好**
 * 是语法树错配节点的标记（而不是它自己那一对的两侧），就照画（修复），并把两侧
 * 标记被这样占用的错配节点撤掉加粗——正文由修复对重新加粗，中间的连接词回到普通字。
 * 两侧被同一节点认领的候选（语法树本来就画了）一律不碰，严格配对的行为不变。
 */
function analyzeEmphasisRepair(
  state: EditorState,
  paragraphs: { from: number; to: number }[],
  emphasis: EmphasisNode[],
): { suppress: Set<number>; repairs: LoosePair[] } {
  const claims = markClaimIndex(emphasis)
  // 第一遍：收集全部修复候选，数每个节点的标记被占用了几次
  const candidates: LoosePair[] = []
  for (const para of paragraphs) {
    if (para.to <= para.from) continue
    const { text, map } = logicalParagraph(state, para)
    enumerateLoosePairs(text, map, claims, (pair) => {
      if (pair.repair) candidates.push(pair)
      return true
    })
  }
  // 只有**两个**标记都被修复对占用的节点才是真被错配的（中间那对 `**和**`，或嵌套
  // 错配的内外两层各被占两次）。只碰到一个标记的，多半是合法配对被路过——不撤它，
  // 碰它的那个候选也不算修复（回到补画的规则里去）。
  const consumed = new Map<number, number>()
  for (const pair of candidates) {
    if (pair.openClaim >= 0) consumed.set(pair.openClaim, (consumed.get(pair.openClaim) ?? 0) + 1)
    if (pair.closeClaim >= 0) consumed.set(pair.closeClaim, (consumed.get(pair.closeClaim) ?? 0) + 1)
  }
  const swallowed = (node: number): boolean => {
    const claim = emphasis[node]
    return !!claim.openMark && !!claim.closeMark && (consumed.get(node) ?? 0) >= 2
  }
  const suppress = new Set<number>()
  const repairs: LoosePair[] = []
  for (const pair of candidates) {
    const touchesSwallowed =
      (pair.openClaim >= 0 && swallowed(pair.openClaim)) || (pair.closeClaim >= 0 && swallowed(pair.closeClaim))
    if (!touchesSwallowed) continue
    repairs.push(pair)
    // 被撤的节点按起点记，collectInline 用它查
    if (pair.openClaim >= 0 && swallowed(pair.openClaim)) suppress.add(emphasis[pair.openClaim].from)
    if (pair.closeClaim >= 0 && swallowed(pair.closeClaim)) suppress.add(emphasis[pair.closeClaim].from)
  }
  return { suppress, repairs }
}

function collectLooseEmphasis(
  state: EditorState,
  paragraphs: { from: number; to: number }[],
  occupy: { from: number; to: number }[],
  ranges: DecorationRange[],
  extras: RevealExtra[] = [],
  emphasis: EmphasisNode[] = [],
  repairs: readonly LoosePair[] = [],
): void {
  // occupy 不是全局有序的（几个收集器各按自己的顺序往里塞）。按 from 排一次，再记一个
  // 「前缀最大 to」：与 [from, to) 相交的区间存在，当且仅当所有 from < to 的区间里最大的
  // to 大于 from。以前是对整个 occupy 线性扫，每个配对扫一遍，大文档里是平方级的。
  const claimed = occupy.slice().sort((a, b) => a.from - b.from)
  const claimedMaxTo: number[] = [0]
  for (let k = 0; k < claimed.length; k++) claimedMaxTo.push(Math.max(claimedMaxTo[k], claimed[k].to))
  const overlaps = (from: number, to: number): boolean => {
    let lo = 0
    let hi = claimed.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (claimed[mid].from < to) lo = mid + 1
      else hi = mid
    }
    return claimedMaxTo[lo] > from
  }
  const claims = markClaimIndex(emphasis)
  const repairKeys = new Set(repairs.map((pair) => `${pair.openFrom}:${pair.closeFrom}`))

  for (const para of paragraphs) {
    if (para.to <= para.from) continue
    const { text, map } = logicalParagraph(state, para)
    // 已画上的区间（本函数产出），单 `*` 不能跨过 `**` 配对
    const painted: { from: number; to: number }[] = []

    enumerateLoosePairs(text, map, claims, (pair) => {
      // 语法树本来就画了这一对：不碰（它的装饰由 collectInline 出）
      if (pair.sameNode) return false
      const isRepair = repairKeys.has(`${pair.openFrom}:${pair.closeFrom}`)
      // 修复对不检查 occupy——它与语法树的交集只在定界符上（错配节点的标记），
      // 内容是干净的。补画对（两侧都没被认领）看**定界符**：定界符本身落在认领区间里
      // （代码、公式、链接地址、HTML 标签里的 `*` 不是定界符）才不画。
      //
      // ColaMD CT（2026-11-24 用户截图：「以**以太网广播帧（目的 MAC 为 `FF:FF…`）**发出」
      // 不加粗）：以前这里是「与任何认领区间相交就不画」，于是加粗**内部**嵌着行内代码、
      // 链接、公式、高亮时整对被否掉。嵌套是合法结构：区间整个落在这对定界符之间就不算冲突。
      // （交叉的情形一定会压到某一侧的定界符上，所以只查定界符就够了。）
      if (!isRepair && (overlaps(pair.openFrom, pair.openFrom + pair.d) || overlaps(pair.closeFrom, pair.closeFrom + pair.d))) {
        return false
      }
      // 已画上的区间（本函数产出）同理：只拦交叉——单 `*` 不能跨过 `**` 配对，
      // 但 `**（a *“b”* c）**` 这种里外都要补画的嵌套要画得出来（谁整个包住谁都算嵌套）
      const nested = (span: { from: number; to: number }): boolean =>
        (pair.from >= span.from && pair.to <= span.to) || (span.from >= pair.from && span.to <= pair.to)
      if (!isRepair && painted.some((span) => pair.from < span.to && pair.to > span.from && !nested(span))) {
        return false
      }
      // 光标在这段强调里（或紧贴两端）时定界符压淡显形，可以就地改（与合法强调同一手感）
      const shown = within(state, pair.from, pair.to)
      const delim = shown ? MARK({ class: 'cm-md-marker' }) : null
      extras.push({ from: pair.from, to: pair.to })
      // 被语法树标记占用的那半个定界符由 collectInline 的标记分支负责藏/显，
      // 这里不再叠一份 replace——两份替换撞同一区间是没定义的行为
      const claimLen = (pos: number): number | undefined => {
        const hit = claims.get(pos)
        return hit && hit.len === pair.d ? hit.len : undefined
      }
      if (claimLen(pair.openFrom) === undefined) {
        ranges.push({ from: pair.openFrom, to: pair.openFrom + pair.d, deco: delim ?? hide(pair.openFrom, pair.openFrom + pair.d) })
      }
      if (claimLen(pair.closeFrom) === undefined) {
        ranges.push({ from: pair.closeFrom, to: pair.closeFrom + pair.d, deco: delim ?? hide(pair.closeFrom, pair.closeFrom + pair.d) })
      }
      ranges.push({ from: pair.openFrom + pair.d, to: pair.closeFrom, deco: MARK({ class: pair.cls }) })
      painted.push({ from: pair.from, to: pair.to })
      return true
    })
  }
}

// ─── 分页 ────────────────────────────────────────────────────────────────────
//
// 一个 `---` 就是一页，这是放映与导出幻灯片 PDF 共用的切法（2026-09-26 定）。
//
// 页码写成行装饰的类名（`cm-md-page-N`），而不是让放映层去数 DOM 的第几个孩子：
// CM6 会往正文里插 gap 元素，序号对不上；而 `---` 在代码块里不是 HorizontalRule，
// 用语法树判断也就不会把代码块里的分隔线当成分页。
// 每页的第一行额外带 `cm-md-page-start`，导出时靠它插分页符。
export const PAGE_CLASS_PREFIX = 'cm-md-page-'
export const PAGE_START_CLASS = 'cm-md-page-start'

function collectPages(state: EditorState, ranges: DecorationRange[], front: Range | null): void {
  const breaks: number[] = []
  iterateContent(state, front, (node) => {
    if (node.name !== 'HorizontalRule') return
    breaks.push(state.doc.lineAt(node.from).number)
  })

  let page = 0
  let nextBreak = 0
  let startsPage = true
  for (let n = 1; n <= state.doc.lines; n++) {
    const lineFrom = state.doc.line(n).from
    const classes = [`${PAGE_CLASS_PREFIX}${page}`]
    if (startsPage) classes.push(PAGE_START_CLASS)
    ranges.push({ from: lineFrom, to: lineFrom, deco: BLOCK(classes.join(' ')) })
    startsPage = false
    // 分隔线归它结束的那一页，下一行开新的一页
    if (nextBreak < breaks.length && breaks[nextBreak] === n) {
      page++
      nextBreak++
      startsPage = true
    }
  }
}

// ─── 大纲跳转的落点高亮 ──────────────────────────────────────────────────────
//
// 用一个 effect 驱动，不再靠「派发一个空选区事务」去逼装饰重算：
// 装饰现在住在 StateField 里，只在文档或选区真的变了时才重算，空事务不会触发它。

export const headingFlashEffect = StateEffect.define<{ from: number; to: number } | null>()

/** 当前的落点高亮区间。effect 与重算共享这一份真相。 */
let currentFlash: { from: number; to: number } | null = null

// ─── 组装 ────────────────────────────────────────────────────────────────────

interface ActiveZone {
  from: number
  to: number
  kind: 'frontmatter' | 'block'
}

const zonesByDeco = new WeakMap<DecorationSet, ActiveZone[]>()

/** 选区当前落进了哪些需要展开源码的块。没变就不必在拖选时重算整篇装饰（#201）。 */
function activeZonesKey(state: EditorState, zones: readonly ActiveZone[]): string {
  if (zones.length === 0) return ''
  const main = state.selection.main
  const parts: string[] = []
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i]
    if (z.kind === 'frontmatter') {
      const hit = state.selection.ranges.some((r) => r.empty && r.head >= z.from && r.head <= z.to)
      if (hit) parts.push(`f:${z.from}:${z.to}`)
    } else if (main.from >= z.from && main.to <= z.to) {
      parts.push(`b:${z.from}:${z.to}`)
    }
  }
  return parts.join('|')
}

function buildDecorations(state: EditorState, flash: { from: number; to: number } | null): DecorationSet {
  const ranges: DecorationRange[] = []
  const zones: ActiveZone[] = []
  const text = state.doc.toString()
  const excluded = excludedRanges(text, syntaxTree(state))
  // 属性区的区间要算一次、多处用：压淡它、把它里面的 YAML 排出 markdown 排版、
  // 不让它的 `---` 被当成分页。
  const front = frontmatterRange(text)
  // 方言开关（偏好设置 → Markdown；见 dialectField）
  const dialect = dialectOf(state)
  // 宽松强调要避开的区间：合法强调/代码/链接由 collectInline 记，公式与高亮在下面记
  const occupy: { from: number; to: number }[] = []
  // 正则类的可披露构造（高亮、宽松强调、成对行内 HTML、脚注引用），见 revealKeyOf
  const extras: RevealExtra[] = []
  // 整段被换成 widget 的行内构造（图片、公式）：别的正则语法（高亮）不许跨过去配对
  const opaque: { from: number; to: number }[] = []
  const paragraphs = collectParagraphs(state, front)
  // 错配修复分析要在 collectInline 之前跑完：哪些节点的加粗要撤、它的定界符要不要跟着
  // 修复对显形，都是 collectInline 画的时候就要知道的事（见 analyzeEmphasisRepair）。
  // 严格方言（宽松强调关闭）不做修复，纯 CommonMark 行为。
  const emphasisNodes = dialect.looseEmphasis ? collectEmphasisNodes(state, front) : []
  const repair = dialect.looseEmphasis
    ? analyzeEmphasisRepair(state, paragraphs, emphasisNodes)
    : { suppress: new Set<number>(), repairs: [] as LoosePair[] }

  if (flash && flash.to <= state.doc.length) {
    ranges.push({ from: flash.from, to: flash.to, deco: MARK({ class: 'cm-md-jump-flash' }) })
  }

  collectBlocks(state, ranges, front)
  collectLinks(state, ranges, front, occupy)
  collectFootnotes(state, text, ranges, front, extras)
  collectHTML(state, ranges, front, zones, occupy, extras)
  collectImages(state, ranges, front, occupy, opaque, extras)
  collectPages(state, ranges, front)
  collectInline(state, ranges, front, occupy, repair.suppress, repair.repairs)
  collectFrontmatter(state, ranges, front, zones)
  collectTables(state, ranges, front, zones)
  collectTaskItems(state, ranges, front)
  collectMermaid(state, text, ranges, front, zones)
  // 公式先于高亮：它整段被换成 widget，区间要先记进 opaque，高亮的 `==` 才知道不能
  // 跨过去配对。入队的先后不要紧，组装前统一排序。
  const widgetMath: { from: number; to: number }[] = []
  collectMath(state, text, excluded, ranges, zones, dialect.inlineMath, occupy, opaque, widgetMath)
  collectHighlight(state, text, ranges, excluded, dialect.highlight, occupy, extras, opaque)
  // 宽松强调垫底：所有合法区间都记完之后才知道哪些空档可以补画、哪些错配要修复
  if (dialect.looseEmphasis) collectLooseEmphasis(state, paragraphs, occupy, ranges, extras, emphasisNodes, repair.repairs)
  // 完全落在公式 widget 区间内部的隐藏装饰，滤掉。它们是嵌在 replace 里的又一层
  // replace（`\(` 的 Escape 藏、公式里被树认领的强调标记…），widget 态下本来就不可见，
  // 滤掉不改任何像素；留着却会让 CodeMirror 的增量 DOM diff 在「源码态 → widget 态」
  // 切换时把整个 widget 丢掉——`\(公式\)` 在行首、光标进出公式时整段渲染成空
  // （2026-11-23 用户报「行内公式不能正常渲染」的其中一条路径，逐时序排查出来的）。
  if (widgetMath.length > 0) {
    for (let i = ranges.length - 1; i >= 0; i--) {
      const entry = ranges[i]
      if (!hiddenDecos.has(entry.deco)) continue
      if (widgetMath.some((span) => entry.from >= span.from && entry.to <= span.to)) ranges.splice(i, 1)
    }
  }

  // 排序键必须带上 startSide：RangeSetBuilder 只接受按 (from, startSide) 递增的顺序，
  // 原来只按 (from, to) 排，同一段区间上挂了两种装饰时就翻车。
  //
  // 真事（#157）：`[![图](pic.png)](https://…)` 这种「链接里只包一张图」的写法，链接
  // mark（startSide 5e8）和图片 widget（startSide 5e8 - 1）盖的是**同一段区间**，(from, to)
  // 完全相等，先后全看数组原来的顺序。mark 排在前面就抛
  // 「Ranges must be added sorted by `from` position and `startSide`」，整个装饰层作废，
  // 表现是文件打开了但正文空白。
  ranges.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, r.deco)
  const deco = builder.finish()
  zonesByDeco.set(deco, zones)
  extrasByDeco.set(deco, extras)
  return deco
}

/**
 * 装饰层。
 *
 * 文档变化、解析推进、导出开关切换、查找的匹配集合变化时重算；单纯移动光标或拖选
 * 文字时，只有跨进/跨出块级替换区（表格、图、块公式、HTML 块、属性区），或者光标
 * 换了一个可披露的构造（见 revealKeyOf），才重算，避免大文档拖选卡死（#201）。
 */
export const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state, null),
  update(deco, tr) {
    const flash = tr.effects.find((effect) => effect.is(headingFlashEffect))
    const flashValue = flash ? (flash.value as { from: number; to: number } | null) : currentFlash
    if (flash) currentFlash = flashValue
    const parsed = tr.effects.some((effect) => effect.is(decorationsRefreshEffect))
    // 文档换了个文件，图片的相对路径要按新的基准重新解析
    const rebased = tr.effects.some((effect) => effect.is(setDocumentFileUrlEffect))
    // 方言开关切换（偏好设置 → Markdown）要整层重算
    const dialectChanged = tr.effects.some((effect) => effect.is(setDialectEffect))
    const clean = tr.state.field(cleanExportField, false) ?? false
    const wasClean = tr.startState.field(cleanExportField, false) ?? false
    // 查找：输入、上一个/下一个、关闭面板都会换一份匹配集合。当前项落在被替换的块里时
    // 那个块要退回源码，表格 widget 里的高亮也要跟着换（见 searchCurrentIn / TableWidget）
    const searchChanged = tr.state.field(searchStateField, false) !== tr.startState.field(searchStateField, false)
    // 只读 ↔ 可编辑：只读时不披露标记（见 revealEnabled）
    const editableNow = tr.state.facet(EditorView.editable) !== false
    const editableBefore = tr.startState.facet(EditorView.editable) !== false
    // 焦点进出编辑器：披露只对正在编辑的编辑器生效。点回原地时光标可能没动，
    // 所以不能只靠选区指纹，焦点事件本身要触发一次重算
    const focusChanged = tr.effects.some((effect) => effect.is(setEditorFocus))
    if (!tr.docChanged && !flash && !parsed && !rebased && !dialectChanged && clean === wasClean
        && !searchChanged && editableNow === editableBefore && !focusChanged) {
      if (!tr.selection) return deco
      const zones = zonesByDeco.get(deco) ?? []
      if (activeZonesKey(tr.state, zones) === activeZonesKey(tr.startState, zones)) {
        const extras = extrasByDeco.get(deco) ?? []
        if (revealKeyOf(tr.state, extras) === revealKeyOf(tr.startState, extras)) return deco
      }
    }
    return buildDecorations(tr.state, flashValue)
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** 解析往前推进之后，请重算一次装饰。 */
export const decorationsRefreshEffect = StateEffect.define<null>()

/**
 * 装饰是从语法树上读出来的，而语法树是**按视口惰性解析**的：长文档刚打开时，
 * 树只覆盖开头一段。用户滚到没解析过的地方，CM6 会照常把那几行渲染出来，但那时
 * 装饰里根本没有它们，于是屏幕上显示的是原始源码（`- **加粗**` 这种），
 * 要等下一次重算（点一下、敲一下）才恢复正常。
 *
 * 所以这里盯着视口：树没铺到视口末尾就推一把解析，解析推进了就请装饰重算一次。
 * `forceParsing` 自己会在树变了之后派发一次空事务，于是这个插件会被再叫一次，
 * 那时再重算，滚动到哪儿就渲染到哪儿。
 *
 * 两件事都推到 `setTimeout` 里做：**update 进行中不允许 dispatch**，就地派发会让
 * 插件直接崩掉（`Calls to EditorView.update are not allowed while an update is in progress`）。
 */
const parseRefresh = ViewPlugin.fromClass(class {
  private parsed = 0
  private pending = false
  private attempts = 0
  update(update: ViewUpdate) {
    const tree = syntaxTree(update.state)
    const grew = tree.length > this.parsed
    this.parsed = tree.length
    const viewportEnd = update.view.viewport.to
    if (tree.length >= viewportEnd) {
      this.attempts = 0
      if (grew) this.later(update.view, null)
      return
    }
    this.later(update.view, viewportEnd)
  }
  private later(view: EditorView, parseTo: number | null, delay = 0) {
    if (this.pending) return
    this.pending = true
    setTimeout(() => {
      this.pending = false
      if (!view.dom.isConnected) return
      // 中文输入法正在组字：这一笔装饰刷新会打断组字，候选框里的字就没了。
      // 等组字结束再来，组字结束本身会让 CodeMirror 再走一次 update。
      // （脚本里的 insertText 不走组字，所以验收覆盖不到这一条，只能靠这条守卫。）
      if (view.composing) {
        this.later(view, parseTo, 120)
        return
      }
      if (parseTo !== null) forceParsing(view, parseTo)
      view.dispatch({ effects: decorationsRefreshEffect.of(null) })
      // `forceParsing` 是有时间预算的：机器忙的时候一次推不到视口末尾，
      // 而装饰是照着语法树算的，树没铺到的地方就会露出原始 markdown。
      // 所以要一直补到铺满为止（次数封顶，避免文档本身有问题时空转）。
      if (syntaxTree(view.state).length < view.viewport.to && this.attempts < 40) {
        this.attempts += 1
        this.later(view, view.viewport.to, delay)
      }
    }, 0)
  }
})

// 这几个必须一起装进编辑器：`livePreviewField` 要读前两个 field，
// 读不到就当成「没有焦点、不在导出」，那一行源码就永远不会显形；
// `parseRefresh` 负责在解析推进后叫它重算。
export const livePreview: Extension = [
  editorFocusField,
  cleanExportField,
  documentFileUrlField,
  dialectField,
  livePreviewField,
  parseRefresh,
]
