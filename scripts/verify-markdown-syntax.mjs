// 全语法渲染审计（ColaMD CT）。
//
// 背景：用户反复遇到「部分语法渲染不出来」。与其一个个打补丁，不如把
// CommonMark + GFM + 本站扩展语法的典型写法全部灌进**真实产物**，逐条断言
// 用户实际看到的东西。判据分两类：
//   text: 渲染后 .cm-content 的 textContent 必须严格等于期望（标记字符不许露出）
//   sel : 某个渲染结果的 DOM 必须存在（或不存在）
// 任何一条不过，就是一个真实的语法渲染问题。
//
// 用法: npm run build && node scripts/verify-markdown-syntax.mjs
//       AUDIT_ONLY=1 时只列出失效项，不判失败（用于盘点）。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500))
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

// ─── 用例库 ───────────────────────────────────────────────────────────────────
// body 会被拼上 '\n\n尾'（光标落到末尾时不在任何块级替换区里），text 期望自动补 '尾'。
const T = (text) => ({ text })
const S = (sel, min = 1) => ({ sel, min })
const N = (sel) => ({ sel, min: 0 })
const FENCE = '```'

const CASES = [
  // ── 强调：星号 ──
  ['加粗', '**加粗**', T('加粗')],
  ['斜体', '*斜体*', T('斜体')],
  ['粗斜体', '***粗斜***', T('粗斜')],
  ['加粗接句号', '**加粗**。', T('加粗。')],
  ['全角括号包裹', '（**加粗**）', T('（加粗）')],
  ['汉字紧贴两侧', '前**加粗**后', T('前加粗后')],
  ['同行两处加粗', '**甲** 和 **乙**', T('甲 和 乙')],
  ['加粗内嵌斜体', '**加粗 *嵌斜体* 文**', T('加粗 嵌斜体 文')],
  ['内容边缘全角引号接字', '**“他说”**然后', T('“他说”然后')],
  ['内容尾全角逗号接字', '**词语，**后', T('词语，后')],
  ['词内星号（规范即为斜体）', '2*3*4', T('234')],
  // ── 强调：跨软换行 ──
  ['跨行加粗', '前**加粗\n续行**后', T('前加粗续行后')],
  ['跨行加粗·全角括号边缘（用户截图）', '上的**分布式\n平台（Socket）**向程序', T('上的分布式平台（Socket）向程序')],
  ['跨行加粗·三行', '**第一行\n第二行\n第三行**', T('第一行第二行第三行')],
  ['引用里跨行加粗·全角标点边缘', '> 上的**分布式\n> 平台（Socket）**向程序', T('上的分布式平台（Socket）向程序')],
  ['列表项里跨行加粗·全角标点边缘（续行缩进空格仍在 DOM）', '- 上的**分布式\n  平台（Socket）**向程序', T('• 上的分布式  平台（Socket）向程序')],
  ['多行 HTML 注释块', '<!-- 多行\n注释 -->\n正文', T('正文')],
  ['标题里的宽松加粗', '# **“他说”**然后', T('“他说”然后')],
  ['转义的定界符不被宽松层补画', '\\*不是斜体\\*', T('*不是斜体*')],
  ['跨行斜体', '前*斜体\n续行*后', T('前斜体续行后')],
  ['跨行加粗内嵌斜体', '**外层 *内\n斜* 层**', T('外层 内斜 层')],
  // ── 强调：下划线 ──
  ['下划线加粗', '__下划粗__', T('下划粗')],
  ['下划线斜体', '_下划斜_', T('下划斜')],
  ['下划线加粗遇汉字', '前__加粗__后', T('前加粗后')],
  ['下划线加粗遇全角句号', '前__加粗__。后', T('前加粗。后')],
  ['下划线加粗跨行', '前__加粗\n续行__后', T('前加粗续行后')],
  // ── 强调：防误伤 ──
  ['snake_case 不变斜体', 'snake_case_word', T('snake_case_word')],
  ['空格分隔的星号不变', 'a * b * c', T('a * b * c')],
  ['开侧带空格不渲染', '** 空格**', T('** 空格**')],
  ['闭侧带空格不渲染', '**空格 **', T('**空格 **')],
  ['未闭合不渲染', '**未闭合', T('**未闭合')],
  ['全角星号不渲染', '＊＊不是标记＊＊', T('＊＊不是标记＊＊')],
  ['行内代码里的星号不变', '`**不是加粗**`', T('**不是加粗**')],
  ['加粗里有行内代码', '**加粗中有 `code` 代码**', T('加粗中有 code 代码')],
  // ── 删除线 / 高亮 ──
  ['删除线', '~~删除~~', T('删除')],
  ['删除线遇全角句号', '前~~删除~~。后', T('前删除。后')],
  ['删除线跨行', '前~~删除\n续行~~后', T('前删除续行后')],
  ['高亮', '==高亮==', T('高亮')],
  ['高亮跨行', '前==高亮\n续行==后', T('前高亮续行后')],
  // ── 转义 ──
  ['转义星号', '\\*不是斜体\\*', T('*不是斜体*')],
  ['转义双星号', '\\*\\*不是加粗\\*\\*', T('**不是加粗**')],
  ['转义井号', '\\# 不是标题', T('# 不是标题')],
  ['转义反引号', '\\`不是代码\\`', T('`不是代码`')],
  ['转义波浪号', '\\~\\~不是删除\\~\\~', T('~~不是删除~~')],
  ['转义美元号', '\\$100', T('$100')],
  ['字面反斜杠', 'a\\\\b', T('a\\b')],
  // ── 行内代码 ──
  ['行内代码', '`code`', T('code')],
  ['双反引号含单反引号', '``a`b``', T('a`b')],
  ['行内代码剥离一格空白', '` 带空格 `', T('带空格')],
  // ── 链接 ──
  ['行内链接', '[链接](https://a.com)', T('链接')],
  ['带标题的链接', '[链接](https://a.com "标题")', T('链接')],
  ['尖括号网址链接', '[链接](<https://a.com/x y>)', T('链接')],
  ['自动链接', '<https://a.com>', T('https://a.com')],
  ['邮箱自动链接', '<a@b.com>', T('a@b.com')],
  ['裸网址', '看https://a.com/x的说明', T('看https://a.com/x的说明')],
  ['中文地址链接', '[文档](./文档.md)', T('文档')],
  ['链接跨行', '[跨行\n链接](https://a.com)', T('跨行链接')],
  ['加粗里的链接', '**[链接](https://a.com)**', T('链接')],
  ['链接里的加粗', '[**加粗**](https://a.com)', T('加粗')],
  ['引用式链接（定义行压淡显示）', '[文字][id]\n\n[id]: https://a.com', T('文字[id]: https://a.com')],
  ['引用式链接渲染为链接', '[文字][id]\n\n[id]: https://a.com', S('.cm-md-link')],
  ['链接定义行压淡', '[文字][id]\n\n[id]: https://a.com', S('.cm-md-linkdef')],
  ['未定义的引用式链接保持原样', '[文字][没有定义]', T('[文字][没有定义]')],
  ['快捷引用式链接', '[文字]\n\n[文字]: https://a.com', T('文字[文字]: https://a.com')],
  ['行首数字加点空格', '1. 项目', T('1. 项目')],
  // ── 标题 ──
  ['一级标题', '# 一级', T('一级')],
  ['六级标题', '###### 六级', T('六级')],
  ['标题带尾部井号（闭合井号前的空格仍在 DOM）', '# 有尾井号 #', T('有尾井号 ')],
  ['井号后无空格不算标题', '#无空格', T('#无空格')],
  ['标题里的加粗', '# **标题**', T('标题')],
  ['Setext 一级', '一级\n===', T('一级')],
  ['Setext 一级有标题样式', '一级\n===', S('.cm-md-atxheading1')],
  ['Setext 二级', '二级\n---', T('二级')],
  ['Setext 二级有标题样式', '二级\n---', S('.cm-md-atxheading2')],
  // ── 列表 ──
  // 列表圆点后的空格、列表续行的缩进空格仍在 DOM 里（视觉上由 CSS 处理），期望照实写
  ['无序列表减号', '- 项目', T('• 项目')],
  ['无序列表星号', '* 项目', T('• 项目')],
  ['无序列表加号', '+ 项目', T('• 项目')],
  ['有序列表点', '1. 项目', T('1. 项目')],
  ['有序列表括号', '1) 项目', T('1) 项目')],
  ['有序列表非一起始', '3. 项目', T('3. 项目')],
  ['嵌套列表', '- 父\n  - 子', T('• 父• 子')],
  ['列表项里的加粗', '- **加粗**', T('• 加粗')],
  ['列表项里的行内代码', '- `code`', T('• code')],
  ['任务列表', '- [ ] 待办', S('.cm-md-task')],
  ['列表项跨行加粗', '- 前面**加粗\n  续行**后面', T('• 前面加粗  续行后面')],
  // ── 引用 ──
  ['引用', '> 引用', T('引用')],
  ['引用多行', '> 引用\n> 第二行', T('引用第二行')],
  ['引用懒续行', '> 引用\n续行', T('引用续行')],
  ['引用里的列表', '> - 列表', T('• 列表')],
  ['引用里的加粗', '> **加粗**', T('加粗')],
  ['引用里跨行加粗', '> 前面**加粗\n> 续行**后面', T('前面加粗续行后面')],
  ['嵌套引用', '> > 内层', T('内层')],
  // ── 代码块 ──
  ['围栏代码块', `${FENCE}\n代码\n${FENCE}`, S('.cm-md-codeblock', 3)],
  ['带语言围栏', `${FENCE}js\nlet a\n${FENCE}`, S('.cm-md-codeblock', 3)],
  ['波浪号围栏', '~~~\n代码\n~~~', S('.cm-md-codeblock', 3)],
  ['缩进代码块', '    缩进代码', S('.cm-md-codeblock')],
  ['缩进代码块去掉行首缩进', '    缩进代码', T('缩进代码')],
  ['代码块里的星号不渲染', `${FENCE}\n**不是加粗**\n${FENCE}`, N('.cm-md-strong')],
  // ── 分割线 ──
  ['分割线减号', '---', T('')],
  ['分割线星号', '***', T('')],
  ['分割线空格', '- - -', T('')],
  ['分割线下划线', '___', T('')],
  // ── 表格 ──
  ['表格', '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |', T('甲乙丙丁')],
  ['表格无首尾竖线', '甲 | 乙\n--- | ---\n丙 | 丁', T('甲乙丙丁')],
  ['表格里的行内格式', '| **粗** | *斜* |\n| --- | --- |\n| a | b |', T('粗斜ab')],
  ['表格转义竖线', '| a \\| b | c |\n| --- | --- |\n| d | e |', T('a | bcde')],
  ['表格对齐标记', '| 甲 | 乙 |\n| :---: | ---: |\n| 丙 | 丁 |', T('甲乙丙丁')],
  ['表格里的行内代码', '| `code` |\n| --- |\n| a |', T('codea')],
  // 单元格是另一套独立的行内渲染器（live-preview 的 appendInline），单独覆盖一遍
  ['表格里的高亮', '| ==高亮== |\n| --- |\n| a |', T('高亮a')],
  ['表格里的嵌套强调', '| **粗 *斜* 粗** |\n| --- |\n| a |', T('粗 斜 粗a')],
  ['表格里的下划线加粗', '| 前__加粗__后 |\n| --- |\n| a |', T('前加粗后a')],
  ['表格里的转义星号', '| \\*转义\\* |\n| --- |\n| a |', T('*转义*a')],
  ['表格里的实体', '| &amp; &lt; |\n| --- |\n| a |', T('& <a')],
  ['表格里的行内 HTML', '| <u>下</u> 与 <b>粗</b> |\n| --- |\n| a |', T('下 与 粗a')],
  ['表格里的上下标', '| H<sub>2</sub>O 与 x<sup>2</sup> |\n| --- |\n| a |', T('H2O 与 x2a')],
  ['表格里的自动链接', '| <https://a.com> |\n| --- |\n| a |', T('https://a.coma')],
  ['表格里的删除线', '| ~~删~~ |\n| --- |\n| a |', T('删a')],
  ['表格里的行内公式', '| 文字 $x$ 文字 |\n| --- |\n| a |', S('.cm-md-table-widget .cm-md-math-inline')],
  ['表格里的 br', '| 上<br>下 |\n| --- |\n| a |', T('上下a')],
  ['表格里的强调含行内代码', '| **粗 `code` 粗** |\n| --- |\n| a |', T('粗 code 粗a')],
  ['表格里 snake_case 不变斜体', '| snake_case_word 与 a_b |\n| --- |\n| a |', T('snake_case_word 与 a_ba')],
  ['表格里代码内的标记不变', '| `**不是加粗**` |\n| --- |\n| a |', T('**不是加粗**a')],
  // ── 公式 ──
  ['行内公式', '文字 $x$ 收尾', S('.cm-md-math-inline')],
  ['块级公式', '$$\nE = mc^2\n$$', S('.cm-md-math-block')],
  ['价格美元号不是公式', '价格 $100 到 $200 之间', N('.cm-md-math-inline')],
  // ── 换行 ──
  ['硬换行（两空格）', '第一行  \n第二行', T('第一行第二行')],
  ['硬换行（反斜杠）', '第一行\\\n第二行', T('第一行第二行')],
  // ── HTML ──
  ['行内 br', '上行<br>下行', T('上行下行')],
  ['行内 u 生效', '<u>下划线</u>', S('.cm-md-html-u')],
  ['行内 b 生效', '<b>加粗</b>', S('.cm-md-html-b')],
  ['行内 em 生效', '<em>斜</em>', S('.cm-md-html-em')],
  ['下标生效', 'H<sub>2</sub>O', S('.cm-md-html-sub')],
  ['上标生效', 'x<sup>2</sup>', S('.cm-md-html-sup')],
  ['kbd 生效', '按 <kbd>Ctrl</kbd> 键', S('.cm-md-html-kbd')],
  ['mark 高亮生效', '<mark>重点</mark>', S('.cm-md-html-mark')],
  ['行内 HTML 里的 markdown 照常渲染', '<u>**加粗下划线**</u>', S('.cm-md-html-u .cm-md-strong, .cm-md-strong')],
  ['带 style 的 span', '<span style="color:red">红字</span>', T('红字')],
  ['带属性的 font 整段画成 HTML', '<font color="red">红字</font>', T('红字')],
  ['行内 a 链接', '<a href="https://a.com">文字</a>', T('文字')],
  ['同名标签嵌套', '<b>外<b>内</b>外</b>', T('外内外')],
  ['行内 u 下划线', '<u>下划线</u>', T('下划线')],
  ['行内 b 加粗', '<b>加粗</b>', T('加粗')],
  ['行内 strong', '<strong>强</strong>', T('强')],
  ['行内 em', '<em>斜</em>', T('斜')],
  ['行内 i', '<i>斜</i>', T('斜')],
  ['行内 code', '<code>代码</code>', T('代码')],
  ['上下标', 'H<sub>2</sub>O 与 x<sup>2</sup>', T('H2O 与 x2')],
  ['kbd 按键', '按 <kbd>Ctrl</kbd> 键', T('按 Ctrl 键')],
  ['HTML 注释', '<!-- 注释 -->正文', T('正文')],
  // ── 脚注 ──
  ['脚注引用', '脚注[^1]\n\n[^1]: 说明', S('.cm-md-footnote-ref')],
  // ── 实体 ──
  ['HTML 实体 amp', 'a &amp; b', T('a & b')],
  ['HTML 实体 lt', 'a &lt; b', T('a < b')],
  ['HTML 实体 数字', '&#65;', T('A')],
  // ── 综合场景 ──
  ['列表项含链接和加粗', '- [**链接**](https://a.com) 说明', T('• 链接 说明')],
  ['标题含链接', '# [标题](https://a.com)', T('标题')],
  ['段落紧接表格前的加粗', '**加粗** 文字\n\n尾', null],
  ['删除线内含加粗', '~~**加粗删除**~~', T('加粗删除')],
  ['高亮内含加粗', '==**加粗高亮**==', T('加粗高亮')],
]

async function main() {
  const auditOnly = process.env.AUDIT_ONLY === '1'
  const { dir: WORK, udd } = verifyWorkdir('md-syntax')
  writeFileSync(join(WORK, 'syntax.md'), '占位\n', 'utf8')
  const port = 9925 + Math.floor(Math.random() * 20)
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'electron', 'cli.js'), 'scripts/offscreen-window.cjs', join(WORK, 'syntax.md'),
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`
  ], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', detached: true })

  let failed = 0
  let passed = 0
  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    for (let i = 0; i < 60; i++) { if (await evaluate(renderer, `!!${VIEW}`)) break; await sleep(250) }
    // 等 file-opened 的初始内容落稳（撞上它会把文档换回去）
    for (let i = 0; i < 40; i++) {
      if ((await evaluate(renderer, `${VIEW}.state.doc.toString()`)) === '占位\n') break
      await sleep(250)
    }
    const setDoc = (text) => evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 0, to: ${VIEW}.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: 0 } })`)
    const setCursor = (anchor) => evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${anchor} }, scrollIntoView: false })`)

    const results = []
    for (const [name, body, expect] of CASES) {
      if (!expect) continue
      const doc = `${body}\n\n尾`
      await setDoc(doc)
      await setCursor(doc.length)
      await sleep(320)
      const got = await evaluate(renderer, `(() => ({
        text: document.querySelector('#editor .cm-content').textContent,
        n: document.querySelectorAll(${JSON.stringify(expect.sel ?? '.none')}).length
      }))()`)
      let ok
      let detail = ''
      if ('text' in expect) {
        const want = `${expect.text}尾`
        ok = got.text === want
        detail = `看到 ${JSON.stringify(got.text)}，应为 ${JSON.stringify(want)}`
      } else {
        ok = expect.min === 0 ? got.n === 0 : got.n >= expect.min
        detail = `${expect.sel} 数量 ${got.n}，应${expect.min === 0 ? '为 0' : `≥ ${expect.min}`}`
      }
      if (ok) passed++
      else failed++
      results.push({ name, ok, detail })
      console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
    }
    console.log(`\n${failed === 0 ? '✓' : '✗'} 语法审计：${passed} 条通过，${failed} 条失效（共 ${passed + failed}）`)
    if (failed && !auditOnly) process.exitCode = 1
  } finally {
    stopVerifyApp(udd)
    try { process.kill(-child.pid) } catch { /* 已经退了 */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
