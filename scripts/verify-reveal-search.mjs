// 光标处披露标记 + 表格里的查找高亮（ColaMD CT，2026-11-23）。
//
// 两件事都是用户点名要的：
//   1. 渲染模式下 `**` 这类标记平时不显示；光标落到标记上时临时显形，可以就地改，
//      光标移开再藏回去（上游此前定成「要改标记只能切源码模式」）。
//   2. Ctrl+F 查找时，表格里的文字要像正文一样高亮（此前只跳到位置，不高亮）。
//
// 全部灌进**真实产物**断言用户实际看到的东西。判据：
//   披露：光标在某处时，那一行 .cm-line 的 textContent 必须严格等于期望
//         （显形 = 源码原文；隐藏 = 干净的渲染文字），并且样式还在（加粗仍是加粗）。
//   查找：.search-match / .search-match-current 必须落在正确的格子里（粗体里、代码里、
//         带转义管子的格子里），当前项所在的公式 / 图 / HTML 块退回源码。
//
// 用法: npm run build && node scripts/verify-reveal-search.mjs
//       SHOT_DIR=<目录> 时额外把关键状态截成 PNG（人工核对观感）。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = process.env.SHOT_DIR || ''

async function waitTarget(port, predicate) {
  const started = Date.now()
  while (Date.now() - started < 30000) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find(predicate)
      if (hit) return hit
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到调试目标')
}

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', {
    expression, includeCommandLineAPI: false, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
    return result.result?.value
  })
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let seq = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
  })
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    }),
  }
}

const VIEW = `(() => {
  const content = document.querySelector('#editor .cm-content')
  const tile = content && (content.cmTile || content.cmView)
  return tile && tile.root && tile.root.view
})()`

// 一像素的图：图片必须真能加载出来，否则「加载失败退回源码」会和披露混在一起
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// ─── 一、光标处披露 ───────────────────────────────────────────────────────────

const REVEAL_DOC = [
  '正文有**加粗**和*斜体*。',                  // 0
  '# 标题文字',                                // 1
  '  ## 缩进标题',                             // 2
  '- 列表项文字',                              // 3
  '  - 子项文字',                              // 4
  '> 引用文字',                                // 5
  '看[链接文字](https://example.com)后面',      // 6
  `![图](${PIXEL}) 后面`,                      // 7
  '转义\\*星号',                               // 8
  '前==高亮==后',                              // 9
  '前__宽松粗__后',                            // 10
  '<u>下划线</u> 后面',                        // 11
  '`代码` 文字',                               // 12
  '~~删除~~ 文字',                             // 13
  '脚注[^1]',                                  // 14
  '',                                          // 15
  '[^1]: 说明',                                // 16
  '',                                          // 17
  // 一句话里两个加粗、内容以全角引号开头结尾：严格解析会把中间那对 `**` 配错，
  // 宽松层修复成两段（见 live-preview 的 analyzeEmphasisRepair）
  '他说**“这个”**和**“那个”**的时候',            // 18
].join('\n')

const LINK = '[链接文字](https://example.com)'
const IMAGE = `![图](${PIXEL})`

// [名称, 行号, 定位串, 相对定位串起点的偏移, 期望的整行文字, 附加断言]
const CLEAN = '正文有加粗和斜体。'
const REVEAL_CASES = [
  ['光标在加粗里：两个 ** 显形，同一行的斜体照旧藏着', 0, '**加粗**', 3, '正文有**加粗**和斜体。',
    (r) => r.markers === '**¦**' && r.strong === '加粗'],
  ['紧贴加粗开头：显形', 0, '**加粗**', 0, '正文有**加粗**和斜体。', (r) => r.markers === '**¦**'],
  ['加粗开头再往前一格：隐藏', 0, '**加粗**', -1, CLEAN, (r) => r.markers === '' && r.strong === '加粗'],
  ['紧贴加粗结尾：显形', 0, '**加粗**', 6, '正文有**加粗**和斜体。', (r) => r.markers === '**¦**'],
  ['加粗结尾再往后一格：加粗藏起来，紧挨着的斜体显形', 0, '**加粗**', 7, '正文有加粗和*斜体*。', (r) => r.markers === '*¦*' && r.strong === '加粗'],
  ['光标在斜体里：只有斜体的 * 显形', 0, '*斜体*', 2, '正文有加粗和*斜体*。', (r) => r.markers === '*¦*' && r.em === '斜体'],
  ['行内代码：反引号显形，仍是代码样式', 12, '`代码`', 2, '`代码` 文字', (r) => r.markers === '`¦`' && r.code === '代码'],
  ['删除线：~~ 显形', 13, '~~删除~~', 3, '~~删除~~ 文字', (r) => r.markers === '~~¦~~' && r.strike === '删除'],
  ['标题：光标在行首，# 显形', 1, '# 标题文字', 0, '# 标题文字', (r) => r.heading && r.markers === '# '],
  ['标题：光标紧贴 # 之后，# 显形', 1, '# 标题文字', 2, '# 标题文字', (r) => r.heading],
  ['标题：光标在标题文字里，# 藏着', 1, '# 标题文字', 4, '标题文字', (r) => r.heading && r.markers === ''],
  ['缩进标题：光标停在缩进里，## 也显形', 2, '  ## 缩进标题', 0, '  ## 缩进标题', (r) => r.heading && r.markers === '## '],
  ['缩进标题：光标在文字里，藏着', 2, '  ## 缩进标题', 6, '缩进标题', (r) => r.heading && r.markers === ''],
  ['列表：光标在行首，- 显形（不画圆点）', 3, '- 列表项文字', 0, '- 列表项文字', (r) => !r.bullet && r.li],
  ['列表：光标在条目文字里，照常是圆点', 3, '- 列表项文字', 4, '• 列表项文字', (r) => r.bullet && r.li],
  ['子列表：光标停在缩进里，缩进和 - 一起显形', 4, '  - 子项文字', 0, '  - 子项文字', (r) => !r.bullet && r.li],
  ['子列表：光标在文字里，是圆点', 4, '  - 子项文字', 6, '• 子项文字', (r) => r.bullet],
  ['引用：光标在行首，> 显形', 5, '> 引用文字', 0, '> 引用文字', (r) => r.quote && r.markers === '>'],
  ['引用：光标在引用文字里，> 藏着', 5, '> 引用文字', 3, '引用文字', (r) => r.quote && r.markers === ''],
  ['链接：光标在链接文字里，整条源码显形', 6, LINK, 3, `看${LINK}后面`, (r) => r.link === null],
  ['链接：只是紧贴在链接前面，不翻出网址', 6, LINK, 0, '看链接文字后面', (r) => r.link === 'https://example.com'],
  ['链接：光标在链接后面，藏着', 6, LINK, LINK.length, '看链接文字后面', (r) => r.link === 'https://example.com'],
  ['图片：光标在图片源码开头，退回源码', 7, IMAGE, 0, `${IMAGE} 后面`, (r) => !r.img],
  ['图片：光标在图片后面，图片照常显示', 7, IMAGE, IMAGE.length + 1, ' 后面', (r) => r.img],
  ['转义：光标紧挨着反斜杠，反斜杠显形', 8, '\\*', 0, '转义\\*星号', (r) => r.markers === '\\'],
  ['转义：光标在行尾，反斜杠藏着', 8, '\\*', 4, '转义*星号', (r) => r.markers === ''],
  ['高亮：光标在高亮里，== 显形', 9, '==高亮==', 3, '前==高亮==后', (r) => r.highlight === '高亮'],
  ['高亮：光标在高亮前面，藏着', 9, '==高亮==', -1, '前高亮后', (r) => r.highlight === '高亮' && r.markers === ''],
  ['宽松强调（__ 紧贴汉字）：光标在里面，__ 显形', 10, '__宽松粗__', 3, '前__宽松粗__后', (r) => r.strong === '宽松粗'],
  ['宽松强调：光标在行尾，藏着', 10, '__宽松粗__', 9, '前宽松粗后', (r) => r.strong === '宽松粗' && r.markers === ''],
  ['行内 HTML：光标在元素里，两头标签显形', 11, '<u>下划线</u>', 5, '<u>下划线</u> 后面', (r) => r.u === '下划线'],
  ['行内 HTML：光标紧贴闭标签之后，标签仍显形', 11, '<u>下划线</u>', 10, '<u>下划线</u> 后面', (r) => r.u === '下划线'],
  ['行内 HTML：光标再往后一格，标签藏着', 11, '<u>下划线</u>', 11, '下划线 后面', (r) => r.u === '下划线'],
  ['脚注引用：光标在引用里，[^1] 源码显形', 14, '[^1]', 2, '脚注[^1]', (r) => !r.footnote],
  ['脚注引用：光标在别的行，画成上标数字', 14, '[^1]', -99, '脚注1', (r) => r.footnote],
  // 错配修复对（宽松层的 repair，v2.7.21）：光标进哪一段，哪一对的 ** 显形；
  // 光标落在被撤掉加粗的连接词上时，那一对（语法树的错配节点）照常显形
  ['错配修复对·光标在第一个短语里：这一对的 ** 显形', 18, '**“这个”**', 3, '他说**“这个”**和“那个”的时候', (r) => r.markers === '**¦**' && r.strong === '“这个”'],
  ['错配修复对·光标在第二个短语里：这一对的 ** 显形', 18, '**“那个”**', 3, '他说“这个”和**“那个”**的时候', (r) => r.markers === '**¦**'],
  // 光标落在单字的连接词上：它紧邻三个构造（前一短语的闭侧、中间那对、后一短语的开侧），
  // 按「紧贴两端也算」的规则三处的标记一起显形
  ['错配修复对·光标在中间的连接词上：紧邻的三对 ** 都显形，连接词不加粗', 18, '和', 0, '他说**“这个”**和**“那个”的时候', (r) => r.markers === '**¦**¦**'],
]

// ─── 二、表格里的查找高亮 ─────────────────────────────────────────────────────

const SEARCH_DOC = [
  '正文里有苹果和香蕉。',                        // 0
  '',                                          // 1
  '| 水果 | 产地 |',                            // 2
  '| --- | --- |',                             // 3
  '| 苹果 | 山东 |',                            // 4
  '| **苹果**汁 | `苹果` 酱 |',                  // 5
  '| 甲 \\| 苹果 | 香蕉 |',                     // 6
  '',                                          // 7
  '$$',                                        // 8
  '苹果 + 1',                                  // 9
  '$$',                                        // 10
  '',                                          // 11
  '```mermaid',                                // 12
  'graph TD; 苹果-->香蕉',                      // 13
  '```',                                       // 14
  '',                                          // 15
  '<div class="box">苹果盒子</div>',            // 16
  '',                                          // 17
  '<https://苹果.example>',                     // 18
  '',                                          // 19
  '[链接文字](https://example.com/苹果)',        // 20
].join('\n')

// 表格单元格里 .search-match 的摘要：[格子的序号, 包在什么元素里, 文字]
const SEARCH_STATE = `(() => {
  const content = document.querySelector('#editor .cm-content')
  const mark = (el) => {
    const cell = el.closest('th, td')
    const inEl = el.closest('strong, code, .cm-md-math, .cm-md-html, .cm-md-mermaid')
    const inLink = !!(el.closest('.cm-md-link') || el.querySelector('.cm-md-link'))
    const inTag = inLink ? 'link' : !inEl ? 'text' : inEl.tagName.toLowerCase()
    return [
      cell ? [...cell.closest('table').querySelectorAll('th, td')].indexOf(cell) : -1,
      el.classList.contains('search-match-current') ? inTag + '!' : inTag,
      el.textContent
    ].join(':')
  }
  return JSON.stringify({
    count: document.querySelector('.search-count')?.textContent ?? '',
    marks: [...content.querySelectorAll('.search-match, .search-match-current')].map(mark),
    table: !!content.querySelector('.cm-md-table-widget'),
    tableText: [...content.querySelectorAll('.cm-md-table-widget th, .cm-md-table-widget td')].map((c) => c.textContent),
    mathBlock: !!content.querySelector('.cm-md-math-block'),
    mermaid: !!content.querySelector('.cm-md-mermaid'),
    htmlBlock: !!content.querySelector('.cm-md-html-block'),
    lineTexts: Object.fromEntries([9, 13, 16, 20].map((n) => [n, (() => {
      if (n + 1 > ${VIEW}.state.doc.lines) return null
      const pos = ${VIEW}.state.doc.line(n + 1).from
      const { node } = ${VIEW}.domAtPos(pos, 1)
      let el = node instanceof Element ? node : node.parentElement
      while (el && !el.classList.contains('cm-line')) el = el.parentElement
      return el ? el.textContent : null
    })()])),
    doc: ${VIEW}.state.doc.toString()
  })
})()`

async function main() {
  const { dir: WORK, udd } = verifyWorkdir('reveal-search')
  writeFileSync(join(WORK, 'reveal.md'), '占位\n', 'utf8')
  const port = 9945 + Math.floor(Math.random() * 20)
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'electron', 'cli.js'), 'scripts/offscreen-window.cjs', join(WORK, 'reveal.md'),
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`
  ], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', detached: true })

  let failed = 0
  let passed = 0
  const check = (name, ok, detail = '') => {
    if (ok) passed++
    else failed++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
  }
  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    for (let i = 0; i < 60; i++) { if (await evaluate(renderer, `!!${VIEW}`)) break; await sleep(250) }
    // 等 file-opened 的初始内容落稳（撞上它会把文档换回去）
    for (let i = 0; i < 40; i++) {
      if ((await evaluate(renderer, `${VIEW}.state.doc.toString()`)) === '占位\n') break
      await sleep(250)
    }
    await evaluate(renderer, `(() => { window.__verifyErrors = []; window.addEventListener('error', (e) => window.__verifyErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__verifyErrors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason))); return true })()`)
    // 离屏窗口被交出了焦点、不跑动画帧：让页面按「有焦点」对待，否则导出态那个钩子
    // （renderWholeDocument 等下一帧）永远等不到。其它套件用这个钩子前也都开了它。
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // 视口撑高一屏多，整篇都在 DOM 里（表格 widget 要渲染出来才查得到）
    await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 2400, deviceScaleFactor: 1, mobile: false })
    await sleep(400)

    const setDoc = (text) => evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 0, to: ${VIEW}.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: ${text.length} } })`)
    const setCursor = (anchor) => evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${anchor} }, scrollIntoView: false })`)
    // 真焦点 + 补一个 focus 事件：离屏窗口里系统焦点不在页面上，浏览器可能不派发 focus/blur
    const focusEditor = () => evaluate(renderer, `(() => { ${VIEW}.focus(); ${VIEW}.contentDOM.dispatchEvent(new FocusEvent('focus')); return document.activeElement === ${VIEW}.contentDOM })()`)
    const blurEditor = () => evaluate(renderer, `(() => { ${VIEW}.contentDOM.blur(); ${VIEW}.contentDOM.dispatchEvent(new FocusEvent('blur')) })()`)

    console.log('一、光标处披露标记')
    // 先确认夹具本身：有焦点、光标在文末时整篇是干净的（没有任何标记露出来）
    await setDoc(REVEAL_DOC)
    const realFocus = await focusEditor()
    await sleep(300)
    const idle = JSON.parse(await evaluate(renderer, `(() => {
      const content = document.querySelector('#editor .cm-content')
      const lines = [...content.querySelectorAll(':scope > .cm-line')]
      return JSON.stringify({
        markers: content.querySelectorAll('.cm-md-marker').length,
        head: ${VIEW}.state.selection.main.head, docLength: ${VIEW}.state.doc.length,
        first: lines[0].textContent, heading: lines[1].textContent, link: lines[6].textContent, footnote: !!content.querySelector('.cm-md-footnote-ref'),
        focused: document.activeElement === content
      })
    })()`))
    check('夹具：编辑器拿到了焦点', realFocus === true && idle.focused, `真焦点=${realFocus} activeElement 是正文=${idle.focused}`)
    check('光标在文末：整篇干净，一个标记都不露', idle.markers === 0 && idle.first === CLEAN && idle.heading === '标题文字' && idle.link === '看链接文字后面' && idle.footnote,
      JSON.stringify(idle))

    const lines = REVEAL_DOC.split('\n')
    const lineStart = (n) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0)
    for (const [name, n, needle, offset, want, extra] of REVEAL_CASES) {
      await focusEditor()
      const pos = offset === -99 ? lineStart(0) + 1 : lineStart(n) + lines[n].indexOf(needle) + offset
      await setCursor(pos)
      await sleep(90)
      const got = JSON.parse(await evaluate(renderer, `(() => {
        const line = document.querySelectorAll('#editor .cm-content > .cm-line')[${n}]
        if (!line) return JSON.stringify({ missing: true })
        const text = (sel) => line.querySelector(sel)?.textContent ?? null
        return JSON.stringify({
          text: line.textContent,
          markers: [...line.querySelectorAll('.cm-md-marker, .cm-md-quotemark, .cm-md-listmark')].map((el) => el.textContent).join('¦'),
          strong: text('.cm-md-strong'), em: text('.cm-md-em'), strike: text('.cm-md-strike'), code: text('.cm-md-inlinecode'),
          highlight: text('.cm-md-highlight'), u: text('.cm-md-html-u'), link: line.querySelector('.cm-md-link')?.getAttribute('data-href') ?? null,
          img: !!line.querySelector('img'), bullet: !!line.querySelector('.cm-md-li-bullet'), footnote: !!line.querySelector('.cm-md-footnote-ref'),
          heading: /cm-md-atxheading[1-6]/.test(line.className), head: ${VIEW}.state.selection.main.head, lineFrom: ${VIEW}.state.doc.line(${n} + 1).from,
          html: line.innerHTML.slice(0, 420), li: /cm-md-li/.test(line.className), quote: line.classList.contains('cm-md-blockquote'),
          doc: ${VIEW}.state.doc.toString()
        })
      })()`))
      const ok = !got.missing && got.text === want && (!extra || extra(got)) && got.doc === REVEAL_DOC
      check(name, ok, `看到 ${JSON.stringify(got.text)}，应为 ${JSON.stringify(want)}；标记=${JSON.stringify(got.markers)} 粗=${got.strong} 斜=${got.em} 链接=${got.link} 图=${got.img} 圆点=${got.bullet} 光标=${got.head}（行首 ${got.lineFrom}）${got.missing ? '' : ' HTML=' + JSON.stringify(got.html)}${got.doc !== REVEAL_DOC ? ' 【缓冲区被改动了】' : ''}`)
    }

    // 焦点门控：同一个光标位置，失焦就藏、拿回焦点又显
    await setDoc(REVEAL_DOC)
    await focusEditor()
    await setCursor(lineStart(0) + '正文有**加'.length)
    await blurEditor()
    await sleep(120)
    const blurred = await evaluate(renderer, `document.querySelectorAll('#editor .cm-content > .cm-line')[0].textContent`)
    check('失焦：光标还在加粗里，标记藏起来', blurred === CLEAN, `看到 ${JSON.stringify(blurred)}`)
    await focusEditor()
    await sleep(120)
    const refocused = await evaluate(renderer, `(() => { const l = document.querySelectorAll('#editor .cm-content > .cm-line')[0]; return l.textContent + '¦' + l.querySelectorAll('.cm-md-marker, .cm-md-quotemark, .cm-md-listmark').length })()`)
    check('拿回焦点（光标没动）：标记重新显形', refocused === '正文有**加粗**和斜体。¦2', `看到 ${JSON.stringify(refocused)}`)
    // 没有焦点时换文档 / 落光标，不该披露（打开文件时光标本来就在正文开头）
    await blurEditor()
    await setDoc(REVEAL_DOC)
    await setCursor(lineStart(1))
    await sleep(120)
    const coldOpen = await evaluate(renderer, `(() => { const l = document.querySelectorAll('#editor .cm-content > .cm-line')[1]; return l.textContent + '¦' + l.querySelectorAll('.cm-md-marker, .cm-md-quotemark, .cm-md-listmark').length })()`)
    check('没有焦点时光标落在 # 标题行首：# 不自己冒出来', coldOpen === '标题文字¦0', `看到 ${JSON.stringify(coldOpen)}`)

    // 真打字：选住开头的 ** 换成 *，再选住结尾的 ** 换成 *——加粗变斜体，全程不切源码模式
    await setDoc(REVEAL_DOC)
    await focusEditor()
    const b = lineStart(0) + '正文有'.length
    await evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${b}, head: ${b + 2} } })`)
    await renderer.send('Input.insertText', { text: '*' })
    await evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${b + 3}, head: ${b + 5} } })`)
    await renderer.send('Input.insertText', { text: '*' })
    const typedDoc = await evaluate(renderer, `${VIEW}.state.doc.toString()`)
    await evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${VIEW}.state.doc.length } })`)
    await sleep(120)
    const afterEdit = await evaluate(renderer, `(() => { const l = document.querySelectorAll('#editor .cm-content > .cm-line')[0]; return JSON.stringify({ text: l.textContent, em: l.querySelectorAll('.cm-md-em').length, strong: l.querySelectorAll('.cm-md-strong').length, markers: l.querySelectorAll('.cm-md-marker').length }) })()`)
    const edited = JSON.parse(afterEdit)
    const wantTyped = REVEAL_DOC.replace('正文有**加粗**', '正文有*加粗*')
    check('就地改标记：选住 ** 打一个 *，缓冲区真的变了', typedDoc === wantTyped, `缓冲区第 0 行=${JSON.stringify(typedDoc.split('\n')[0])}，应为 ${JSON.stringify(wantTyped.split('\n')[0])}`)
    check('就地改标记：加粗变斜体，光标移开后是干净的渲染', edited.text === CLEAN && edited.em === 2 && edited.strong === 0 && edited.markers === 0, afterEdit)

    // 导出：披露的标记不该上纸
    await setDoc(REVEAL_DOC)
    await focusEditor()
    await setCursor(lineStart(0) + '正文有**加'.length)
    await sleep(100)
    await evaluate(renderer, `(async () => { await window.__colamdPrintExport.enter() })()`)
    await sleep(300)
    const exported = JSON.parse(await evaluate(renderer, `JSON.stringify({ html: window.__colamdExportDocumentHTML(), markers: document.querySelectorAll('#editor .cm-md-marker').length })`))
    await evaluate(renderer, `window.__colamdPrintExport.exit()`)
    await sleep(300)
    const backFromExport = await evaluate(renderer, `(() => { const l = document.querySelectorAll('#editor .cm-content > .cm-line')[0]; return l.textContent + '¦' + l.querySelectorAll('.cm-md-marker, .cm-md-quotemark, .cm-md-listmark').length })()`)
    check('导出态：光标还在加粗里，纸上没有 **', exported.markers === 0 && !exported.html.includes('**') && exported.html.includes('<strong>加粗</strong>'),
      `页面上的标记数=${exported.markers} 导出 HTML 开头=${JSON.stringify(exported.html.slice(0, 160))}`)
    check('退出导出态：标记重新显形', backFromExport === '正文有**加粗**和斜体。¦2', `看到 ${JSON.stringify(backFromExport)}`)

    if (SHOT_DIR) {
      mkdirSync(SHOT_DIR, { recursive: true })
      // 放大 2 倍拍：1 倍下斜体字的细笔画看着像星号，容易看走眼（2026-11-23 就为这个虚惊了一场）。
      // 断言才是判据，截图是给人工核对观感的；拍的是哪一刻（光标在哪、行文本是什么）一并打出来对照。
      const shot = async (name, cssWidth, cssHeight) => {
        const rect = JSON.parse(await evaluate(renderer, `JSON.stringify(document.querySelector('#editor .cm-content').getBoundingClientRect().toJSON())`))
        const moment = await evaluate(renderer, `(() => { const lines = [...document.querySelectorAll('#editor .cm-content > .cm-line')]; return '光标 ' + ${VIEW}.state.selection.main.anchor + '..' + ${VIEW}.state.selection.main.head + '，前两行 ' + JSON.stringify(lines.slice(0, 2).map((l) => l.textContent)) })()`)
        console.log(`  [截图] ${name}：${moment}`)
        const { data } = await renderer.send('Page.captureScreenshot', {
          format: 'png', clip: { x: rect.x, y: Math.max(0, rect.y), width: cssWidth, height: cssHeight, scale: 2 },
        })
        writeFileSync(join(SHOT_DIR, name), Buffer.from(data, 'base64'))
      }
      await setCursor(lineStart(0) + '正文有**加'.length)
      await sleep(250)
      await shot('reveal-bold.png', 440, 140)
      await setCursor(lineStart(1))
      await sleep(250)
      await shot('reveal-heading.png', 440, 330)
      await setCursor(lineStart(3))
      await sleep(250)
      await shot('reveal-list.png', 440, 330)
    }

    // 大文档：光标每跨过一个构造就重算一次装饰，量一量有多贵
    const bigLines = []
    for (let i = 0; i < 1500; i++) bigLines.push(`第${i}段有**加粗${i}**、[链接${i}](https://example.com/${i})和\`代码${i}\`，还有 ==高亮${i}==。`)
    const BIG = bigLines.join('\n')
    await setDoc(BIG)
    await focusEditor()
    await sleep(600)
    const perf = JSON.parse(await evaluate(renderer, `(() => {
      const view = ${VIEW}
      const doc = view.state.doc.toString()
      const inside = (n) => { const start = doc.indexOf('第' + n + '段'); return start + doc.slice(start).indexOf('加粗' + n) + 1 }
      view.dispatch({ selection: { anchor: inside(30) }, scrollIntoView: true })
      const t0 = performance.now()
      for (let i = 0; i < 120; i++) view.dispatch({ selection: { anchor: inside(10 + (i % 90)) }, scrollIntoView: false })
      const crossing = performance.now() - t0
      const t1 = performance.now()
      for (let i = 0; i < 120; i++) view.dispatch({ selection: { anchor: inside(30) + (i % 5) }, scrollIntoView: false })
      const withinSame = performance.now() - t1
      const line = [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.startsWith('第30段有**加粗30**'))
      view.dispatch({ selection: { anchor: inside(30) }, scrollIntoView: false })
      return JSON.stringify({ crossing, withinSame, lines: view.state.doc.lines, bytes: doc.length, revealed: !!line })
    })()`))
    check('大文档：滚到第 30 行把光标放进加粗里，标记照样显形', perf.revealed === true)
    const perCross = perf.crossing / 120
    const perSame = perf.withinSame / 120
    check(`大文档（${perf.lines} 行 / ${perf.bytes} 字节）：跨构造移动光标每次重算不超过 80ms`,
      perCross < 80, `跨构造 ${perCross.toFixed(1)}ms/次；构造内移动 ${perSame.toFixed(2)}ms/次（不该重算）`)
    check('大文档：在同一个构造里逐字移动不触发重算（明显快于跨构造）', perSame < perCross / 4 || perSame < 2,
      `构造内 ${perSame.toFixed(2)}ms/次，跨构造 ${perCross.toFixed(1)}ms/次`)

    console.log('二、表格里的查找高亮')
    await setDoc(SEARCH_DOC)
    await blurEditor()
    await setCursor(SEARCH_DOC.length)
    // 打开面板走页面自己的 Ctrl+F 兜底（主进程菜单的加速键在无头环境里按不到）
    const openPanel = () => evaluate(renderer, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
      const p = document.querySelector('.search-panel')
      return !!(p && p.getBoundingClientRect().height > 0)
    })()`)
    check('Ctrl+F 弹出查找面板', (await openPanel()) === true)
    const query = async (text) => {
      await evaluate(renderer, `(() => { const input = document.querySelector('.search-panel .search-input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await sleep(220)
      return JSON.parse(await evaluate(renderer, SEARCH_STATE))
    }
    const press = async (key, where, extra = {}) => {
      await evaluate(renderer, `(() => { const el = document.querySelector(${JSON.stringify(where)}); el.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })})); return true })()`)
      await sleep(220)
      return JSON.parse(await evaluate(renderer, SEARCH_STATE))
    }
    const tableMarks = (state) => state.marks.filter((m) => !m.startsWith('-1:'))
    const htmlOf = (needle) => evaluate(renderer, `(() => { const l = [...document.querySelectorAll('#editor .cm-line')].find((x) => x.textContent.includes(${JSON.stringify(needle)})); return l ? l.innerHTML.slice(0, 520) : null })()`)

    // 公式 / 图 / HTML 块是异步画的，等它们就位再断言「没轮到它就还是渲染好的」
    await sleep(1500)
    let state = await query('苹果')
    check('正文里的匹配照常高亮，计数对得上', state.count === '1/10' && state.marks[0] === '-1:text!:苹果', `计数=${state.count} 首个=${state.marks[0]}`)
    check('表格保持渲染（不因为查找退回源码）', state.table && state.tableText.join('¦') === '水果¦产地¦苹果¦山东¦苹果汁¦苹果 酱¦甲 | 苹果¦香蕉', `格子=${JSON.stringify(state.tableText)}`)
    check('表格里的四处匹配全部高亮，当前项不在表里所以都不是「当前」色', tableMarks(state).join(' ') === '2:text:苹果 4:strong:苹果 5:code:苹果 6:text:苹果',
      `表内高亮=${JSON.stringify(tableMarks(state))}`)
    check('粗体里的匹配：高亮包在 <strong> 里面（格式不丢）', state.marks.includes('4:strong:苹果'))
    check('行内代码里的匹配：高亮包在 <code> 里面', state.marks.includes('5:code:苹果'))
    check('带转义管子的格子（甲 \\| 苹果）：高亮落在对的字上', state.marks.includes('6:text:苹果'), JSON.stringify(state.marks))
    check('不是当前项的公式 / 图 / HTML 块保持渲染', state.mathBlock && state.mermaid && state.htmlBlock,
      `公式=${state.mathBlock} 图=${state.mermaid} HTML=${state.htmlBlock}`)
    check('自动链接：地址就是链接文字，高亮直接落在上面', state.marks.includes('-1:link:苹果'), `${JSON.stringify(state.marks)} 行内 HTML=${JSON.stringify(await htmlOf('.example'))}`)
    check('不是当前项、藏在网址里的匹配：链接保持渲染', state.lineTexts[20] === '链接文字', `第 20 行=${JSON.stringify(state.lineTexts[20])}`)

    // 「下一个」一路走：当前项换色，走到哪个块哪个块退回源码，走开再渲染回去
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 表格第 1 格：这一处换成「当前」色，计数 2/10', state.count === '2/10' && state.marks.includes('2:text!:苹果') && !state.marks.includes('-1:text!:苹果'),
      `计数=${state.count} 表内=${JSON.stringify(tableMarks(state))}`)
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 粗体格子里的那一处是当前项', state.count === '3/10' && state.marks.includes('4:strong!:苹果'), JSON.stringify(tableMarks(state)))
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 行内代码里的那一处是当前项', state.count === '4/10' && state.marks.includes('5:code!:苹果'), JSON.stringify(tableMarks(state)))
    if (SHOT_DIR) {
      // 此刻：当前项在行内代码那一格（当前色），其余三处是普通高亮色
      mkdirSync(SHOT_DIR, { recursive: true })
      const rect = JSON.parse(await evaluate(renderer, `JSON.stringify(document.querySelector('#editor .cm-content').getBoundingClientRect().toJSON())`))
      const { data } = await renderer.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: Math.max(0, rect.y), width: Math.min(rect.width, 860), height: 330, scale: 1.5 } })
      writeFileSync(join(SHOT_DIR, 'search-table.png'), Buffer.from(data, 'base64'))
    }
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 带转义管子的格子：当前项换色', state.count === '5/10' && state.marks.includes('6:text!:苹果') && !state.marks.includes('5:code!:苹果'), JSON.stringify(tableMarks(state)))
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 块公式：公式退回源码，高亮落在源码上；表格照旧渲染', state.count === '6/10' && !state.mathBlock && state.lineTexts[9] === '苹果 + 1' && state.marks.includes('-1:text!:苹果') && state.table,
      `计数=${state.count} 公式块还在=${state.mathBlock} 第 9 行=${JSON.stringify(state.lineTexts[9])} 表格=${state.table}`)
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → Mermaid：图退回源码；公式渲染回去', state.count === '7/10' && !state.mermaid && state.lineTexts[13] === 'graph TD; 苹果-->香蕉' && state.mathBlock,
      `图还在=${state.mermaid} 第 13 行=${JSON.stringify(state.lineTexts[13])} 公式块=${state.mathBlock}`)
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → HTML 块：退回源码', state.count === '8/10' && !state.htmlBlock && state.lineTexts[16] === '<div class="box">苹果盒子</div>' && state.mermaid,
      `HTML 块还在=${state.htmlBlock} 第 16 行=${JSON.stringify(state.lineTexts[16])} 图=${state.mermaid}`)
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 自动链接：当前色落在地址上', state.count === '9/10' && state.marks.includes('-1:link!:苹果') && state.htmlBlock,
      `计数=${state.count} ${JSON.stringify(state.marks)}`)
    state = await press('Enter', '.search-panel .search-input')
    check('下一个 → 链接的网址里：整条链接退回源码，网址上的高亮看得见', state.count === '10/10' && state.lineTexts[20] === '[链接文字](https://example.com/苹果)' && state.marks.includes('-1:text!:苹果'),
      `计数=${state.count} 第 20 行=${JSON.stringify(state.lineTexts[20])}`)
    state = await press('Enter', '.search-panel .search-input')
    check('再下一个 → 绕回第一处：所有块渲染回去，表格里的当前色撤掉', state.count === '1/10' && state.mathBlock && state.mermaid && state.htmlBlock && !tableMarks(state).some((m) => m.includes('!')) && state.lineTexts[20] === '链接文字',
      `计数=${state.count} 公式=${state.mathBlock} 图=${state.mermaid} HTML=${state.htmlBlock} 表内=${JSON.stringify(tableMarks(state))}`)

    // 只有一处匹配且在表格里：它就是当前项，表格照样渲染
    state = await query('山东')
    check('唯一匹配在表格里：表格保持渲染，这一处是当前色', state.count === '1/1' && state.table && tableMarks(state).join(' ') === '3:text!:山东', `计数=${state.count} 表内=${JSON.stringify(tableMarks(state))}`)
    state = await query('水果 | 产地')
    check('匹配跨过管子：管子两边的文字各自高亮，管子本身不画', state.count === '1/1' && tableMarks(state).join(' ') === '0:text!:水果 1:text!:产地', `表内=${JSON.stringify(tableMarks(state))}`)
    state = await query('|')
    check('只匹配到管子：分隔用的管子（页面上不存在）不画高亮，转义的 \\| 那一根（显示出来了）才亮', tableMarks(state).join(' ') === '6:text:|' && state.table, `计数=${state.count} 表内=${JSON.stringify(tableMarks(state))}`)
    state = await query('---')
    check('只匹配到分隔行（页面上不存在）：格子里不乱画高亮', tableMarks(state).length === 0 && state.table, `计数=${state.count} 表内=${JSON.stringify(tableMarks(state))}`)

    // 替换：改的是缓冲区，表格重新渲染
    state = await query('山东')
    await evaluate(renderer, `(() => { const input = document.querySelector('.search-panel .search-replace-input'); input.value = '山西'; document.querySelector('.search-panel .search-action').click() })()`)
    await sleep(300)
    state = JSON.parse(await evaluate(renderer, SEARCH_STATE))
    check('在表格里替换：缓冲区改了，表格重新渲染成新文字', state.doc === SEARCH_DOC.replace('| 山东 |', '| 山西 |') && state.tableText[3] === '山西' && state.count === '0/0',
      `第 4 行=${JSON.stringify(state.doc.split('\n')[4])} 格子=${JSON.stringify(state.tableText)} 计数=${state.count}`)

    // 关面板：高亮全部撤掉（正文里、表格里都不剩）
    await evaluate(renderer, `document.querySelector('.search-panel .search-close').click()`)
    await sleep(250)
    state = JSON.parse(await evaluate(renderer, SEARCH_STATE))
    check('关闭面板：正文和表格里的高亮都撤干净', state.marks.length === 0 && state.table, `残留=${JSON.stringify(state.marks)}`)
    await openPanel()

    // 查找面板自己的两个老 bug（这次一并修了）
    await setDoc('İİ 目标')
    await setCursor(5)
    state = await query('目标')
    check('匹配位置按原文字符数算（İ 这类小写后会变长的字符不把位置带偏）', state.count === '1/1' && state.marks.join(' ') === '-1:text!:目标', `计数=${state.count} ${JSON.stringify(state.marks)}`)
    await evaluate(renderer, `(() => { const input = document.querySelector('.search-panel .search-replace-input'); input.value = '替换'; document.querySelector('.search-panel .search-action').click() })()`)
    await sleep(250)
    const replacedDoc = await evaluate(renderer, `${VIEW}.state.doc.toString()`)
    check('替换落到对的地方：İİ 替换', replacedDoc === 'İİ 替换', `缓冲区=${JSON.stringify(replacedDoc)}`)
    await setDoc('aaaa')
    await setCursor(4)
    state = await query('aa')
    check('重叠的匹配只算不重叠的：aaaa 里找 aa 是 2 处', state.count === '1/2', `计数=${state.count}`)
    await evaluate(renderer, `(() => { const input = document.querySelector('.search-panel .search-replace-input'); input.value = 'bb' })()`)
    state = await press('Enter', '.search-panel .search-replace-input', { ctrlKey: true })
    check('全部替换：aaaa → bbbb（重叠的改动不再让编辑器报错）', state.doc === 'bbbb', `缓冲区=${JSON.stringify(state.doc)}`)
    const errors = JSON.parse(await evaluate(renderer, `JSON.stringify(window.__verifyErrors)`))
    check('整轮运行没有渲染进程报错', errors.length === 0, JSON.stringify(errors))

    console.log(`\n${failed === 0 ? '✓' : '✗'} 光标披露 + 表格查找：${passed} 条通过，${failed} 条没通过（共 ${passed + failed}）`)
    if (failed) process.exitCode = 1
  } finally {
    stopVerifyApp(udd)
    try { process.kill(-child.pid) } catch { /* 已经退了 */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
