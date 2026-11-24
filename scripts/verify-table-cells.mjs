// 表格格子结算 + 单元格行内渲染验收（ColaMD CT，2026-11-24）。
//
// 起因：用户报「点击表格中有格式的元素，再点另一个表格位置，格式就消失」。实测确认是真丢格式：
// 格子就地编辑在失焦结算时把格子的**纯文本**（渲染后去掉标记的文字）整个写回源码，
// `**加粗**` 被冲成 `加粗`，而且写进了文件。
//
// 断言两件事：
//   结算   点进带格式的格子再点走，源码一字不变；在加粗里外补字、整段替换、整段删除、
//          删公式、删图片，改动落在源码里正确的位置，标记保留、空掉的定界符对清掉；
//          Tab / Esc 结算照常落盘。点格子、打字都是真实鼠标 / 键盘事件。
//   渲染   单元格行内渲染器（cell-inline.ts）对嵌套强调、代码、公式、链接、HTML、上下标……
//          画出来的结构逐一断言（以前是一条大正则，`*a **b** c*` 会配错）。
//
// 用法: npm run build && node scripts/verify-table-cells.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, reporter, sleep } from './ct-harness.mjs'

const report = reporter('表格格子结算与单元格渲染')
const app = await launchApp('ct-table-cells')
const { ev, doc, setDoc, type, renderer, click, center } = app

// 一张 200×120 的纯色 PNG（图片格子要有真图可删）
const zlib = await import('node:zlib')
const pngOf = (w, h, [r, g, b]) => {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
mkdirSync(join(app.WORK, 'img'), { recursive: true })
writeFileSync(join(app.WORK, 'img', 'a.png'), pngOf(200, 120, [60, 120, 200]))

const tr = (row) => `document.querySelectorAll('.cm-md-table-widget tr')[${row}]`
const td = (row, col) => `${tr(row)}.children[${col}]`
const inTd = (row, col, selector) => `(${td(row, col)}).querySelector('${selector}')`
/** 点一格并等它真的进入编辑态（focusCell 走 rAF）。 */
const clickCell = async (row, col) => {
  const point = await center(td(row, col))
  await click(point.x, point.y)
  for (let i = 0; i < 60; i++) {
    if (await ev(`(() => { const el = ${td(row, col)}; return document.activeElement === el && el.getAttribute('contenteditable') !== null })()`)) return
    await sleep(100)
  }
}
const setRange = (body) => ev(`(() => { const range = ${body}; const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); return true })()`)
const caretIn = (row, col, selector, toEnd) => setRange(`(() => { const r = document.createRange(); r.selectNodeContents(${inTd(row, col, selector)}); r.collapse(${!toEnd}); return r })()`)
const commitElsewhere = async () => { await clickCell(2, 2); await sleep(300) }
/**
 * 点进格子后直接改 DOM，再点别处结算。
 * 交界处、整段删除这类位置，脚本设的光标会被浏览器规范化挪走，真人鼠标点出来的落点才是准的；
 * 所以这些场景直接按「浏览器会把字落在这儿」改 DOM，专测结算逻辑。
 */
const editCell = async (row, col, mutation) => {
  await clickCell(row, col)
  await ev(`(() => { const el = ${td(row, col)}; (${mutation})(el); return true })()`)
  await commitElsewhere()
}
/** 第 n 行表格源码按格子取内容（表格每次写回都会按列宽重新对齐空白，不能整行比）。 */
const line = async (n) => {
  const rows = (await doc()).split('\n')
  return rows[n].split('|').slice(1, -1).map((cell) => cell.trim()).join(' | ')
}
const expectLine = async (name, n, want) => report.check(name, (await line(n)) === want, `第 ${n + 1} 行是 ${JSON.stringify(await line(n))}，应为 ${JSON.stringify(want)}`)

try {
  const tableText = [
    '| 名称 | 说明 | 备注 |',
    '| --- | --- | --- |',
    '| **加粗**尾 | 普通 | `代码` 与 $x^2$ |',
    '| *斜体*后文 | ![图](img/a.png)尾 | [链接](https://a.b) |',
    '',
  ].join('\n')
  await setDoc(tableText)
  await sleep(400)

  console.log('一、结算：没改就不动，改了只动改动的地方')
  // T1：点进带格式的格子再点别处 → 源码一字不变（用户报的场景）
  const before = await doc()
  await clickCell(1, 0)
  await clickCell(2, 1)
  await sleep(300)
  report.check('T1 点进加粗格再点别格，源码不变', (await doc()) === before, JSON.stringify(await doc()))

  // T2：加粗内部开头补字（真实按键）
  await clickCell(1, 0)
  await caretIn(1, 0, 'strong', false)
  await type('a')
  await commitElsewhere()
  await expectLine('T2 加粗内部开头补 a', 2, '**a加粗**尾 | 普通 | `代码` 与 $x^2$')

  // T3：加粗之后、普通文字「尾」之前多出一个字（在加粗之外）
  await editCell(1, 0, `(cell) => { cell.querySelector('strong').after(document.createTextNode('b')) }`)
  await expectLine('T3 加粗之后补 b（落在闭侧 ** 之后）', 2, '**a加粗**b尾 | 普通 | `代码` 与 $x^2$')

  // T4：加粗内部末尾补字（真实按键）
  await clickCell(1, 0)
  await caretIn(1, 0, 'strong', true)
  await type('c')
  await commitElsewhere()
  await expectLine('T4 加粗内部末尾补 c（落在闭侧 ** 之前）', 2, '**a加粗c**b尾 | 普通 | `代码` 与 $x^2$')

  // T5：加粗词整段换成别的字
  await editCell(1, 0, `(cell) => { cell.querySelector('strong').textContent = 'h' }`)
  await expectLine('T5 加粗词整段换成 h', 2, '**h**b尾 | 普通 | `代码` 与 $x^2$')

  // T6：加粗词整段删掉 → 空掉的 **** 一并消失
  await editCell(1, 0, `(cell) => { cell.querySelector('strong').remove() }`)
  await expectLine('T6 删掉整个加粗词', 2, 'b尾 | 普通 | `代码` 与 $x^2$')

  // T7：斜体之后（格子末尾）多出一个字
  await editCell(2, 0, `(cell) => { cell.appendChild(document.createTextNode('z')) }`)
  await expectLine('T7 斜体之后补 z', 3, '*斜体*后文z | ![图](img/a.png)尾 | [链接](https://a.b)')

  // T8：行内代码里补字（真实按键）
  await clickCell(1, 2)
  await caretIn(1, 2, 'code', true)
  await type('q')
  await commitElsewhere()
  await expectLine('T8 行内代码里补 q', 2, 'b尾 | 普通 | `代码q` 与 $x^2$')

  // T9：链接文字中间补字（真实按键；这一格自己就是 (2,2)，换一格点过去才结算）
  await clickCell(2, 2)
  await setRange(`(() => { const r = document.createRange(); r.setStart(${inTd(2, 2, 'a')}.firstChild, 1); r.collapse(true); return r })()`)
  await type('d')
  await clickCell(1, 1)
  await sleep(300)
  await expectLine('T9 链接文字里补 d', 3, '*斜体*后文z | ![图](img/a.png)尾 | [链d接](https://a.b)')

  // T10：普通格子里敲 markdown 语法再 Tab → 下一格接上焦点，这一格按 markdown 渲染
  await clickCell(0, 1)
  await setRange(`(() => { const r = document.createRange(); r.selectNodeContents(${td(0, 1)}); r.collapse(false); return r })()`)
  await type('==n==')
  await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await sleep(500)
  await expectLine('T10 敲 ==n== 后按 Tab', 0, '名称 | 说明==n== | 备注')
  const focus10 = await ev(`(() => { const el = document.activeElement; return el ? [...document.querySelectorAll('.cm-md-table-widget td, .cm-md-table-widget th')].indexOf(el) : -1 })()`)
  report.check('T10 Tab 后焦点在下一格（表头第 3 格）', String(focus10) === '2', `焦点在第 ${focus10} 格`)
  report.check('T10 提交后 ==n== 画成高亮', (await ev(`!!(${inTd(0, 1, 'mark')})`)) === true)

  // T11：Esc 结束编辑，改动照样落盘
  await clickCell(2, 0)
  await setRange(`(() => { const r = document.createRange(); r.selectNodeContents(${td(2, 0)}); r.collapse(false); return r })()`)
  await type('w')
  await app.press('Escape', 'Escape', 27)
  await sleep(300)
  await expectLine('T11 敲 w 后按 Esc，改动落盘', 3, '*斜体*后文zw | ![图](img/a.png)尾 | [链d接](https://a.b)')

  // T12 / T13：公式、图片整块删掉
  await editCell(1, 2, `(cell) => { cell.querySelector('.cm-md-math').remove() }`)
  await expectLine('T12 删掉格子里的公式', 2, 'b尾 | 普通 | `代码q` 与')
  await editCell(2, 1, `(cell) => { cell.querySelector('img').remove() }`)
  await expectLine('T13 删掉格子里的图片', 3, '*斜体*后文zw | 尾 | [链d接](https://a.b)')

  // T14：斜体之前（格子开头、斜体之外）多出一个字
  await editCell(2, 0, `(cell) => { cell.insertBefore(document.createTextNode('p'), cell.firstChild) }`)
  await expectLine('T14 斜体之前补 p（落在开侧 * 之前）', 3, 'p*斜体*后文zw | 尾 | [链d接](https://a.b)')

  // T15：公式格 / 链接格 / 高亮格点进点出不变
  const before15 = await doc()
  await clickCell(0, 1)
  await clickCell(2, 2)
  await clickCell(0, 0)
  await sleep(300)
  report.check('T15 高亮格 / 链接格 / 表头点进点出，源码不变', (await doc()) === before15, JSON.stringify(await doc()))

  console.log('二、单元格行内渲染')
  // 源码 → 期望的结构（[公式] [图] [换行] [HTML] 是不可拆的显示单元）
  const CASES = [
    ['*a **b** c*', '<em>a <strong>b</strong> c</em>'],
    ['**粗 *斜* 粗**', '<strong>粗 <em>斜</em> 粗</strong>'],
    ['***粗斜***', '<em><strong>粗斜</strong></em>'],
    ['`a**b` 与 **c**', '<code>a**b</code> 与 <strong>c</strong>'],
    ['以**以太网广播帧（目的 MAC 为 `FF`）**发出；', '以<strong>以太网广播帧（目的 MAC 为 <code>FF</code>）</strong>发出；'],
    ['**“这个”**和**“那个”**', '<strong>“这个”</strong>和<strong>“那个”</strong>'],
    ['a~~b~~c', 'a<s>b</s>c'],
    ['x==y==z', 'x<mark>y</mark>z'],
    ['__加粗__', '<strong>加粗</strong>'],
    ['snake_case_name', 'snake_case_name'],
    ['前_斜_后', '前<em>斜</em>后'],
    ['<u>下划线</u>与H<sub>2</sub>O', '<u>下划线</u>与H<sub>2</sub>O'],
    ['a <br> b', 'a [换行] b'],
    ['a<br/>b', 'a[换行]b'],
    ['a<br />b', 'a[换行]b'],
    ['<hr>', '[HTML]'],
    ['&amp; &lt; \\*', '& < *'],
    ['https://example.com/路径。后文', '<a href="https://example.com/">https://example.com/</a>路径。后文'],
    ['[**粗链接**](https://a.b)', '<a href="https://a.b"><strong>粗链接</strong></a>'],
    ['`code`**粗**', '<code>code</code><strong>粗</strong>'],
    ['a*b', 'a*b'],
    ['*a*b', '<em>a</em>b'],
    ['**a**和**b**', '<strong>a</strong>和<strong>b</strong>'],
    ['**a****b**', '<strong>a</strong><strong>b</strong>'],
    ['*a**b*', '<em>a</em><em>b</em>'],
    ['~~删**粗**除~~', '<s>删<strong>粗</strong>除</s>'],
    ['$a*b*c$ 与 *d*', '[公式] 与 <em>d</em>'],
    ['2*3*4', '2<em>3</em>4'],
    ['a_b_c', 'a_b_c'],
    ['H~2~O', 'H<sub>2</sub>O'],
    ['x^2^ 与 5~10天，7~12天', 'x<sup>2</sup> 与 5~10天，7~12天'],
    ['<span style="color:red">红字</span>后', '<span>红字</span>后'],
    ['<!-- 注释 -->可见', '可见'],
    ['空 ` ` 格', '空 <code> </code> 格'],
    ['``a`b``', '<code>a`b</code>'],
    ['[空](https://x.y)', '<a href="https://x.y">空</a>'],
    ['a\\*b*c', 'a*b*c'],
    ['**a\\*b**', '<strong>a*b</strong>'],
    ['*x*{y}', '<em>x</em>{y}'],
    ['a**b**c**d', 'a<strong>b</strong>c**d'],
    ['<img src="img/a.png" alt="图" width="30">', '[图]'],
  ]
  await setDoc(`| 内容 |\n| --- |\n${CASES.map(([source]) => `| ${source} |`).join('\n')}\n`)
  await sleep(700)
  const rendered = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.cm-md-table-widget tbody td')].map((cell) => {
    const normalize = (node) => {
      if (node.nodeType === 3) return node.data
      if (!(node instanceof Element)) return ''
      if (node.tagName === 'BR') return '[换行]'
      if (node.tagName === 'IMG') return '[图]'
      if (node.classList.contains('cm-md-math')) return '[公式]'
      if (node.classList.contains('cm-md-html-inline')) return '[HTML]'
      if (node.classList.contains('search-match') || node.classList.contains('search-match-current')) {
        return [...node.childNodes].map(normalize).join('')
      }
      const htmlClass = [...node.classList].find((name) => name.startsWith('cm-md-html-'))
      const tag = htmlClass ? htmlClass.slice('cm-md-html-'.length) : node.tagName.toLowerCase()
      const open = node.tagName === 'A' ? '<a href="' + (node.getAttribute('href') ?? '') + '">' : '<' + tag + '>'
      return open + [...node.childNodes].map(normalize).join('') + '</' + tag + '>'
    }
    return [...cell.childNodes].map(normalize).join('')
  }))`))
  for (let i = 0; i < CASES.length; i++) {
    report.check(`渲染 ${JSON.stringify(CASES[i][0])}`, rendered[i] === CASES[i][1], `看到 ${rendered[i]}`)
  }
  const imgWidth = await ev(`document.querySelector('.cm-md-table-widget tbody td:last-child img')?.getAttribute('width')`)
  report.check('格子里的 <img width> 生效', imgWidth === '30', `width=${imgWidth}`)

  const errors = JSON.parse(await ev(`JSON.stringify(window.__verifyErrors ?? [])`))
  report.check('整轮运行没有渲染进程报错', errors.length === 0, JSON.stringify(errors))
} finally {
  app.stop()
}
report.summary()
