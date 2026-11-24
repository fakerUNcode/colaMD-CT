// ColaMD CT 验收脚本的公共脚手架：启动真实构建（离屏窗口、看不见也不抢焦点）、
// 连调试端口、一批常用操作（设文档、挪光标、真实按键、真实鼠标）。
//
// 每个脚本仍然**一次只跑一条**（verify-workdir 的 stopVerifyApp 会杀掉所有验收实例，
// 并行跑会互相误杀）。`launchApp(name)` 的 name 同时是工作目录与 profile 的名字。
//
// 用法:
//   import { launchApp, reporter, sleep, CTRL, ALT, SHIFT } from './ct-harness.mjs'
//   const app = await launchApp('ct-xxx')
//   try { … await app.setDoc('…'); await app.press('KeyB', 'b', 66, CTRL) … }
//   finally { app.stop() }
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** CDP 的修饰键位。 */
export const CTRL = 2
export const ALT = 1
export const SHIFT = 8

/** 统一的断言输出：逐条打 ✓ / ✗，收尾给总数；有失败就把退出码置 1。 */
export function reporter(title) {
  let passed = 0
  let failed = 0
  const check = (name, ok, detail = '') => {
    if (ok) passed++
    else failed++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `  ← ${detail}`}`)
  }
  return {
    check,
    summary: () => {
      console.log(`\n${failed === 0 ? '✓' : '✗'} ${title}：${passed} 条通过，${failed} 条没通过（共 ${passed + failed}）`)
      if (failed) process.exitCode = 1
    },
  }
}

async function waitTarget(port) {
  const started = Date.now()
  while (Date.now() - started < 30000) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find((target) => target.type === 'page' && /index\.html/.test(target.url))
      if (hit) return hit
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到调试目标')
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
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

/** CodeMirror 的 EditorView（从内容区的内部属性上取，验收脚本专用）。 */
export const VIEW = `(() => {
  const content = document.querySelector('#editor .cm-content')
  const tile = content && (content.cmTile || content.cmView)
  return tile && tile.root && tile.root.view
})()`

/**
 * 启动真实应用。`settings` 非空时先把它写进 profile 的 settings.json（测「带着已有改绑启动」）。
 * 返回常用操作；用完必须 `stop()`。
 */
export async function launchApp(name, options = {}) {
  assertBuildFresh()
  const { dir: WORK, udd } = verifyWorkdir(name)
  if (options.settings) {
    mkdirSync(udd, { recursive: true })
    writeFileSync(join(udd, 'settings.json'), JSON.stringify(options.settings, null, 2), 'utf8')
  }
  const port = 9800 + Math.floor(Math.random() * 90)
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'electron', 'cli.js'), 'scripts/offscreen-window.cjs', join(WORK, 'doc.md'),
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`
  ], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', detached: true })
  const stop = () => {
    stopVerifyApp(udd)
    try { process.kill(-child.pid) } catch { /* 已经退了 */ }
  }

  writeFileSync(join(WORK, 'doc.md'), '占位\n', 'utf8')
  const page = await waitTarget(port)
  const renderer = await connect(page.webSocketDebuggerUrl)
  const ev = (expression) => renderer.send('Runtime.evaluate', {
    expression, includeCommandLineAPI: false, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 700))
    return result.result?.value
  })
  try {
    for (let i = 0; i < 60; i++) { if (await ev(`!!${VIEW}`)) break; await sleep(250) }
    for (let i = 0; i < 40; i++) {
      if ((await ev(`${VIEW}.state.doc.toString()`)) === '占位\n') break
      await sleep(250)
    }
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await renderer.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
  } catch (error) {
    stop()
    throw error
  }

  const doc = () => ev(`${VIEW}.state.doc.toString()`)
  const select = (anchor, head = anchor) => ev(`(() => { ${VIEW}.dispatch({ selection: { anchor: ${anchor}, head: ${head} }, scrollIntoView: false }); ${VIEW}.focus(); ${VIEW}.contentDOM.dispatchEvent(new FocusEvent('focus')); return true })()`)

  return {
    WORK,
    ev,
    renderer,
    doc,
    select,
    /** 整篇换掉，光标放到末尾。 */
    setDoc: (text) => ev(`${VIEW}.dispatch({ changes: { from: 0, to: ${VIEW}.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: ${text.length} } })`),
    head: () => ev(`${VIEW}.state.selection.main.head`),
    /**
     * 真实按键：物理键 code + 修饰键，和用户敲出来的事件一样走 document 的 keydown。
     * `text` 有值时是「打字」（keydown 带字符，走浏览器自己的编辑命令，contenteditable 里也管用）。
     */
    press: async (code, key, vk, modifiers = 0, text) => {
      const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
      await renderer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
      await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(150)
    },
    /** 逐个字符打字（真实按键；只支持 ASCII）。 */
    type: async (text) => {
      for (const ch of text) {
        const vk = ch.toUpperCase().charCodeAt(0)
        await renderer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
        await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      }
      await sleep(250)
    },
    /** 元素中心的视口坐标。 */
    center: (selectorExpr) => ev(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`),
    mouse: (x, y, type, extra = {}) => renderer.send('Input.dispatchMouseEvent', { type, x, y, ...extra }),
    /** 真实鼠标点击（左键 / 右键）。 */
    click: async (x, y, button = 'left') => {
      await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 })
      await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, buttons: 0 })
      await sleep(700)
    },
    stop,
  }
}
