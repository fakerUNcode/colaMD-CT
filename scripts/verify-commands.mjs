// 格式命令验收（ColaMD CT，2026-11-23）。
//
// 起因：用户反馈「行内公式空有设置，既没有自定义快捷键入口，也没有在菜单栏」——
// 一个格式要算「实现了」，得同时有：菜单项、默认快捷键、偏好设置里的改绑入口。
// 上标 / 下标 / 脚注此前也缺这三样。此前没有任何验收脚本碰过格式命令本身。
//
// 断言三层是不是真的接到了同一个键：
//   注册表  id 唯一、键位归一后唯一（可以直接 import 源码里的注册表）
//   菜单    格式 / 插入面板里点得到，提示文字与注册表的键位一致
//   键盘    用 CDP 发**真实按键事件**（物理键 + 修饰键），缓冲区必须真的变了
// 另外覆盖脚注的编号与落点、上下标的切换、渲染结果。
//
// 用法: npm run build && node scripts/verify-commands.mjs
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'
import { EDITOR_COMMANDS, normalizeAccelerator } from '../src/shared/commands.ts'

assertBuildFresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CTRL = 2
const ALT = 1
const SHIFT = 8

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  ← ${detail}`}`)
}

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

const hintOf = (accelerator) => accelerator.replace('CmdOrCtrl', 'Ctrl')

// ─── 一、注册表 ───────────────────────────────────────────────────────────────
console.log('一、命令注册表')
const ids = EDITOR_COMMANDS.map((command) => command.id)
check('命令 id 唯一', new Set(ids).size === ids.length)
const bound = EDITOR_COMMANDS.filter((command) => command.accelerator)
const keys = bound.map((command) => normalizeAccelerator(command.accelerator))
check('默认键位互不重复', new Set(keys).size === keys.length,
  keys.filter((key, i) => keys.indexOf(key) !== i).join(' '))
for (const [id, accelerator, zh] of [
  ['superscript', 'CmdOrCtrl+Shift+6', '上标'],
  ['subscript', 'CmdOrCtrl+Shift+`', '下标'],
  ['footnote', 'CmdOrCtrl+Alt+F', '脚注'],
  ['mathInline', 'CmdOrCtrl+Shift+J', '行内公式'],
]) {
  const spec = EDITOR_COMMANDS.find((command) => command.id === id)
  check(`注册表里有「${zh}」，默认键位 ${hintOf(accelerator)}`, !!spec && spec.zh === zh && spec.accelerator === accelerator,
    spec ? `id=${spec.id} zh=${spec.zh} accelerator=${spec.accelerator}` : '没有这个命令')
}
// 键位必须是「物理键」形式：渲染端按 event.code 匹配，`^` 这种按字符写的默认键位永远匹配不上
const physical = /^[a-z0-9`\-=[\]\\;',./]$|f\d{1,2}|space/
check('所有默认键位的键都是物理键形式（渲染端按 event.code 匹配）',
  bound.every((command) => physical.test(normalizeAccelerator(command.accelerator).split('+').pop() ?? '')),
  bound.map((command) => command.accelerator).filter((accelerator) => !physical.test(normalizeAccelerator(accelerator).split('+').pop() ?? '')).join(' '))

// ─── 二、真实应用 ─────────────────────────────────────────────────────────────
const { dir: WORK, udd } = verifyWorkdir('commands')
writeFileSync(join(WORK, 'commands.md'), '占位\n', 'utf8')
const port = 9992 + Math.floor(Math.random() * 6)
const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'electron', 'cli.js'), 'scripts/offscreen-window.cjs', join(WORK, 'commands.md'),
  `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`
], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', detached: true })

try {
  const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
  const renderer = await connect(page.webSocketDebuggerUrl)
  for (let i = 0; i < 60; i++) { if (await evaluate(renderer, `!!${VIEW}`)) break; await sleep(250) }
  for (let i = 0; i < 40; i++) {
    if ((await evaluate(renderer, `${VIEW}.state.doc.toString()`)) === '占位\n') break
    await sleep(250)
  }
  await evaluate(renderer, `(() => { window.__verifyErrors = []; window.addEventListener('error', (e) => window.__verifyErrors.push(String(e.message))); return true })()`)
  await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 2400, deviceScaleFactor: 1, mobile: false })
  await sleep(400)

  const setDoc = (text) => evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 0, to: ${VIEW}.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: ${text.length} } })`)
  const select = (anchor, head = anchor) => evaluate(renderer, `(() => { ${VIEW}.dispatch({ selection: { anchor: ${anchor}, head: ${head} }, scrollIntoView: false }); ${VIEW}.focus(); ${VIEW}.contentDOM.dispatchEvent(new FocusEvent('focus')); return true })()`)
  const doc = () => evaluate(renderer, `${VIEW}.state.doc.toString()`)
  const head = () => evaluate(renderer, `${VIEW}.state.selection.main.head`)
  /** 真实按键：物理键 code + 修饰键，和用户敲出来的事件一样走 document 的 keydown。 */
  const press = async (code, key, vk, modifiers) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await renderer.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    }
    await sleep(120)
  }
  const sup = () => press('Digit6', '^', 54, CTRL | SHIFT)
  const sub = () => press('Backquote', '~', 192, CTRL | SHIFT)
  const footnote = () => press('KeyF', 'f', 70, CTRL | ALT)

  console.log('二、菜单')
  const menuLabels = async (moduleId) => {
    const open = await evaluate(renderer, `!!document.querySelector('.colamd-menu-panel')`)
    // 悬停切换：面板开着时把鼠标移到另一个模块按钮上就换栏；先关掉再点最稳
    if (open) await evaluate(renderer, `document.getElementById('app-menu-btn-${moduleId}').click()`)
    await evaluate(renderer, `document.getElementById('app-menu-btn-${moduleId}').click()`)
    await sleep(250)
    const items = JSON.parse(await evaluate(renderer, `JSON.stringify([...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].map((row) => ({
      label: (row.querySelector('.colamd-menu-label')?.textContent ?? '').trim(),
      hint: (row.querySelector('.colamd-menu-hint')?.textContent ?? '').trim(),
    })))`))
    await evaluate(renderer, `document.getElementById('app-menu-btn-${moduleId}').click()`)
    await sleep(150)
    return items
  }
  const formatItems = await menuLabels('format')
  const insertItems = await menuLabels('insert')
  for (const [label, accelerator] of [['上标', 'Ctrl+Shift+6'], ['下标', 'Ctrl+Shift+`'], ['行内公式', 'Ctrl+Shift+J']]) {
    const hit = formatItems.find((item) => item.label === label)
    check(`「格式」里有「${label}」，提示 ${accelerator}`, !!hit && hit.hint === accelerator, JSON.stringify(hit ?? null))
  }
  const fmtFootnote = formatItems.find((item) => item.label === '脚注')
  check('「格式」里有「脚注」，提示 Ctrl+Alt+F', !!fmtFootnote && fmtFootnote.hint === 'Ctrl+Alt+F', JSON.stringify(fmtFootnote ?? null))
  const insFootnote = insertItems.find((item) => item.label === '脚注')
  check('「插入」里也有「脚注」', !!insFootnote && insFootnote.hint === 'Ctrl+Alt+F', JSON.stringify(insFootnote ?? null))

  console.log('三、键盘：上下标')
  await setDoc('甲乙丙\n\n尾')
  // 选住「甲乙」→ Ctrl+Shift+6 → 包进 <sup>
  await select(0, 2)
  await sup()
  check('选中文字按 Ctrl+Shift+6（即 Ctrl+Shift+^）：包进 <sup>', (await doc()) === '<sup>甲乙</sup>丙\n\n尾', JSON.stringify(await doc()))
  check('包裹后光标落在标记里面（紧挨着的标记会显形）', (await head()) === '<sup>甲乙'.length)
  await sup()
  check('再按一次：取消上标（切换）', (await doc()) === '甲乙丙\n\n尾', JSON.stringify(await doc()))
  await sup()
  check('第三次：重新包上', (await doc()) === '<sup>甲乙</sup>丙\n\n尾', JSON.stringify(await doc()))
  // 「丙」在 <sup>甲乙</sup> 之后
  await select('<sup>甲乙</sup>丙'.length - 1, '<sup>甲乙</sup>丙'.length)
  await sub()
  check('选中文字按 Ctrl+Shift+`（即 Ctrl+Shift+~）：包进 <sub>', (await doc()) === '<sup>甲乙</sup><sub>丙</sub>\n\n尾', JSON.stringify(await doc()))

  console.log('四、键盘：脚注')
  // 光标放到第一行末尾，按 Ctrl+Alt+F：行尾插入 [^1]，文末补定义，光标落进定义
  await select('<sup>甲乙</sup><sub>丙</sub>'.length)
  await footnote()
  const afterFirst = await doc()
  check('Ctrl+Alt+F：光标处插入 [^1]，文末另起一段补上定义', afterFirst === '<sup>甲乙</sup><sub>丙</sub>[^1]\n\n尾\n\n[^1]: ', JSON.stringify(afterFirst))
  check('光标落在脚注定义里等着写说明', (await head()) === afterFirst.length, `光标=${await head()} 文档长度=${afterFirst.length}`)
  await renderer.send('Input.insertText', { text: '说明' })
  await sleep(100)
  // 光标挪到「尾」那一行末尾再按一次：编号递增为 2
  const beforeSecond = afterFirst.replace('\n\n[^1]: ', '')
  await select(beforeSecond.length)
  await footnote()
  const afterSecond = await doc()
  check('再插一个：编号接着往下排 [^2]，与上一个定义之间隔空行',
    afterSecond === '<sup>甲乙</sup><sub>丙</sub>[^1]\n\n尾[^2]\n\n[^1]: 说明\n\n[^2]: ', JSON.stringify(afterSecond))
  // 有选区时引用落在选区末尾；已有的最大编号是 7，新编号从 8 起
  await setDoc('词语甲\n\n尾\n\n[^7]: 已有')
  await select(0, 2)
  await footnote()
  check('有选区：引用落在选区末尾；编号跳过已有的 7', (await doc()) === '词语[^8]甲\n\n尾\n\n[^7]: 已有\n\n[^8]: ', JSON.stringify(await doc()))

  console.log('五、渲染')
  const LINE = 'H<sub>2</sub>O 与 x<sup>2</sup>，脚注[^1]。'
  await setDoc(`${LINE}\n\n尾\n\n[^1]: 说明`)
  // 光标放到「尾」那一行末尾：首行没有任何构造被披露
  await select(LINE.length + '\n\n尾'.length)
  await sleep(150)
  const rendered = JSON.parse(await evaluate(renderer, `JSON.stringify({
    sup: [...document.querySelectorAll('#editor .cm-md-html-sup')].map((el) => el.textContent),
    sub: [...document.querySelectorAll('#editor .cm-md-html-sub')].map((el) => el.textContent),
    refs: [...document.querySelectorAll('#editor .cm-md-footnote-ref')].map((el) => el.textContent),
    first: document.querySelectorAll('#editor .cm-content > .cm-line')[0].textContent,
    defLine: document.querySelectorAll('#editor .cm-content > .cm-line')[4].textContent,
  })`))
  check('上标 / 下标按语义标签渲染', rendered.sup.join('¦') === '2' && rendered.sub.join('¦') === '2', JSON.stringify(rendered))
  check('脚注引用画成上标编号，标签不露出', rendered.refs.join('¦') === '1' && rendered.first === 'H2O 与 x2，脚注1。', `refs=${JSON.stringify(rendered.refs)} 首行=${JSON.stringify(rendered.first)}`)
  check('定义行保留原文 [^1]: 说明（标签不再被换成上标）', rendered.defLine === '[^1]: 说明', JSON.stringify(rendered.defLine))

  console.log('六、菜单点击路径')
  await setDoc('甲乙丙\n\n尾')
  await select(0, 2)
  await evaluate(renderer, `document.getElementById('app-menu-btn-format').click()`)
  await sleep(250)
  const clicked = await evaluate(renderer, `(() => {
    const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((r) => (r.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === '上标')
    if (!row) return false
    row.click()
    return true
  })()`)
  await sleep(200)
  check('点菜单里的「上标」：选中文字被包进 <sup>（菜单不夺焦点）', clicked && (await doc()) === '<sup>甲乙</sup>丙\n\n尾', JSON.stringify(await doc()))

  const errors = JSON.parse(await evaluate(renderer, `JSON.stringify(window.__verifyErrors)`))
  check('整轮运行没有渲染进程报错', errors.length === 0, JSON.stringify(errors))

  console.log(`\n${failed === 0 ? '✓' : '✗'} 格式命令：${passed} 条通过，${failed} 条没通过（共 ${passed + failed}）`)
  if (failed) process.exitCode = 1
} finally {
  stopVerifyApp(udd)
  try { process.kill(-child.pid) } catch { /* 已经退了 */ }
}
