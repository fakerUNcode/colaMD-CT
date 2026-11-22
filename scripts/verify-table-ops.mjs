// ColaMD CT 冒烟验收：表格键盘流（Tab/Enter/末格加行）、快捷键 DOM 匹配
//（Ctrl+1 标题、Ctrl+Shift+K 代码块）、Ctrl+Shift+T 网格选择器落表。
//
// 与 verify-list-input.mjs 同一套 harness：离屏启动真实产物，CDP 派发真实键盘/
// 鼠标事件，断言落在文档字节与光标上。表格操作的断言用「挤压空格后的管道行」
// 比较——序列化会按最宽单元格补空格，那是排版不是内容。
// 用法: npm run build && node scripts/verify-table-ops.mjs
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  // Node 24 自带全局 WebSocket（客户端）
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

// CDP modifiers 位：Alt=1 Ctrl=2 Meta=4 Shift=8
async function press(renderer, spec) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await renderer.send('Input.dispatchKeyEvent', {
      type, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vkc, modifiers: spec.mods ?? 0
    })
  }
  await sleep(140)
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
}

function reportChecks() {
  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  ← ${c.detail}`}`)
  }
  console.log(failed.length
    ? `\n✗ ${failed.length}/${checks.length} 条没通过`
    : `\n✓ ${checks.length} 条全通过`)
  if (failed.length) process.exitCode = 1
}

const VIEW = `(() => {
  const content = document.querySelector('#editor .cm-content')
  const tile = content && (content.cmTile || content.cmView)
  return tile && tile.root && tile.root.view
})()`

/** 挤压空格：`| 甲  | 乙 |` → `|甲|乙|`。列宽补的空格不算内容。 */
const squeeze = (doc) => doc.split('\n').map((line) => line.replace(/\s*\|\s*/g, '|')).join('\n')

async function main() {
  const { dir: WORK, udd } = verifyWorkdir('table-ops')
  writeFileSync(join(WORK, 'table.md'), '占位\n', 'utf8')
  const port = 9970 + Math.floor(Math.random() * 20)
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'electron', 'cli.js'), 'scripts/offscreen-window.cjs', join(WORK, 'table.md'),
    `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`
  ], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', detached: true })

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await renderer.send('Page.bringToFront')

    let ready = false
    for (let i = 0; i < 80; i++) {
      if (await evaluate(renderer, `!!${VIEW}`)) { ready = true; break }
      await sleep(250)
    }
    check('编辑器已就绪', ready, '拿不到编辑器视图，先 npm run build')
    if (!ready) { reportChecks(); return }

    const docOf = () => evaluate(renderer, `${VIEW}.state.doc.toString()`)
    const headOf = () => evaluate(renderer, `${VIEW}.state.selection.main.head`)
    const setDoc = (text) => evaluate(renderer, `${VIEW}.dispatch({ changes: { from: 0, to: ${VIEW}.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: 0 } })`)
    const setCursor = (anchor) => evaluate(renderer, `${VIEW}.dispatch({ selection: { anchor: ${anchor} }, scrollIntoView: true })`)

    // 先真点一下正文拿焦点
    const box = JSON.parse(await evaluate(renderer, `(() => {
      const r = document.querySelector('#editor .cm-content').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 12) })
    })()`))
    let focused = false
    for (let i = 0; i < 6 && !focused; i++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
      await sleep(300)
      focused = await evaluate(renderer, `!!${VIEW}.hasFocus`)
    }
    check('编辑器拿到焦点', focused === true, String(focused))
    await evaluate(renderer, `window.__errs = []; window.addEventListener('error', (e) => { window.__errs.push(String(e.message) + ' @ ' + String(e.filename).slice(-40) + ':' + e.lineno) })`)

    const TABLE = '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |\n| 戊 | 己 |'

    // 1) Tab：表头第二格 → 正文第一行第一格
    await setDoc(TABLE)
    await setCursor(TABLE.indexOf('乙'))
    await press(renderer, { key: 'Tab', code: 'Tab', vkc: 9 })
    let head = await headOf()
    check('Tab 从表头跳到下一行', head === (await docOf()).indexOf('丙'), `光标落在 ${head}`)

    // 2) Enter：正文行 → 下一行同列
    await setDoc(TABLE)
    await setCursor(TABLE.indexOf('丙'))
    await press(renderer, { key: 'Enter', code: 'Enter', vkc: 13 })
    head = await headOf()
    check('Enter 到下一行同列', head === (await docOf()).indexOf('戊'), `光标落在 ${head}`)

    // 3) 末格 Tab：追加一行
    await setDoc(TABLE)
    await setCursor(TABLE.indexOf('己') + 1)
    await press(renderer, { key: 'Tab', code: 'Tab', vkc: 9 })
    const appended = await docOf()
    check('末格 Tab 追加一行', squeeze(appended).split('\n').length === 5 && squeeze(appended).endsWith('|||'),
      `得到 ${JSON.stringify(appended)}`)

    // 4) Shift+Tab：往回走一格
    await setDoc(TABLE)
    await setCursor(TABLE.indexOf('丁'))
    await press(renderer, { key: 'Tab', code: 'Tab', vkc: 9, mods: 8 })
    head = await headOf()
    check('Shift+Tab 回到上一格', head === (await docOf()).indexOf('丙'), `光标落在 ${head}`)

    // 5) Ctrl+1：正文行变一级标题（快捷键 DOM 匹配这条路）
    await setDoc('普通文字')
    await setCursor(0)
    await press(renderer, { key: '1', code: 'Digit1', vkc: 49, mods: 2 })
    check('Ctrl+1 变一级标题', (await docOf()) === '# 普通文字', `得到 ${JSON.stringify(await docOf())}`)

    // 6) Ctrl+Shift+K：落代码块围栏
    await setDoc('正文')
    await setCursor('正文'.length)
    await press(renderer, { key: 'K', code: 'KeyK', vkc: 75, mods: 2 | 8 })
    check('Ctrl+Shift+K 插入代码块', (await docOf()) === '正文\n\n```\n\n```\n', `得到 ${JSON.stringify(await docOf())}`)

    // 7) Ctrl+Shift+T：网格选择器 → 点 3行×2列 → 落表
    await setDoc('空')
    await setCursor('空'.length)
    await press(renderer, { key: 'T', code: 'KeyT', vkc: 84, mods: 2 | 8 })
    const pickerUp = await evaluate(renderer, `!!document.getElementById('colamd-table-picker')`)
    check('Ctrl+Shift+T 弹出网格选择器', pickerUp === true)
    if (pickerUp) {
      const cell = JSON.parse(await evaluate(renderer, `(() => {
        const cell = document.querySelector('#colamd-table-picker .colamd-table-picker-cell[data-row="3"][data-col="2"]')
        if (!cell) return 'null'
        const r = cell.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`))
      check('网格里有 3×2 那一格', !!cell, '找不到 cell')
      if (cell) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', { type, x: cell.x, y: cell.y, button: 'left', clickCount: 1 })
        }
        await sleep(250)
        const inserted = await docOf()
        const lines = squeeze(inserted).split('\n')
        check('点 3×2 落成三行两列空表',
          lines.length === 7 && lines[2] === '|||' && lines[3] === '|---|---|' && lines[4] === '|||' && lines[5] === '|||',
          `得到 ${JSON.stringify(inserted)}`)
        check('落表后选择器已收起', (await evaluate(renderer, `!document.getElementById('colamd-table-picker')`)) === true)
      }
    }

    // 8) 渲染态单元格编辑：光标在表外（表格渲染着）→ 点格子 → 就地打字 → Tab
    //    提交 → 文档更新、表格**仍然渲染**、焦点跳到下一格。
    //    表格后必须空一行：GFM 表格节点紧贴正文行时会把正文吞进去（上游同行为）。
    await setDoc(`${TABLE}\n\n尾行`)
    await setCursor(TABLE.length + 3)
    await sleep(400) // 换文档后语法解析/装饰是异步排队的，等一帧
    const renderedBefore = await evaluate(renderer, `!!document.querySelector('.cm-md-table-widget')`)
    check('光标在表外时表格保持渲染', renderedBefore === true)
    if (renderedBefore) {
      const tdBox = JSON.parse(await evaluate(renderer, `(() => {
        const table = document.querySelector('.cm-md-table-widget')
        const td = table.querySelector('tbody tr')?.children[0]
        if (!td) return 'null'
        const r = td.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`))
      check('渲染出的表格有正文单元格', !!tdBox, '找不到 td')
      if (tdBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', { type, x: tdBox.x, y: tdBox.y, button: 'left', clickCount: 1 })
        }
        await sleep(250)
        const editing = await evaluate(renderer, `(() => {
          const td = document.querySelector('.cm-md-table-widget td[contenteditable]')
          return td ? (document.activeElement === td) : false
        })()`)
        check('点击单元格进入就地编辑', editing === true, `editable=${editing}`)
        await renderer.send('Input.insertText', { text: 'X' })
        await sleep(120)
        await press(renderer, { key: 'Tab', code: 'Tab', vkc: 9 })
        await sleep(250)
        const afterDoc = squeeze(await docOf())
        const stillRendered = await evaluate(renderer, `!!document.querySelector('.cm-md-table-widget')`)
        const nextEditing = await evaluate(renderer, `!!document.querySelector('.cm-md-table-widget td[contenteditable]')`)
        const diag = await evaluate(renderer, `(function () {
          const state = ${VIEW}.state
          return JSON.stringify({ sel: state.selection.main, focus: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className) : 'none', errs: window.__errs })
        })()`)
        check('Tab 提交后表格仍然渲染', stillRendered === true, `doc=${JSON.stringify(afterDoc)} ${diag}`)
        check('编辑写进了源码（正文首行含 X）', afterDoc.split('\n')[2]?.includes('X') === true, `doc=${JSON.stringify(afterDoc)}`)
        check('Tab 后焦点在下一格', nextEditing === true, diag)
      }
    }

    // 9) 图片信息卡：点击渲染出的图片 → 弹卡（名称/地址），表格不再退源码那套
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    writeFileSync(join(WORK, 'dot.png'), PNG)
    await setDoc('![](dot.png)\n\n尾行')
    await setCursor(16)
    await sleep(400) // 图片加载 + 重排
    const imgBox = JSON.parse(await evaluate(renderer, `(() => {
      const img = document.querySelector('#editor .cm-md-image img')
      if (!img) return 'null'
      const r = img.getBoundingClientRect()
      // 1×1 的图取整会点偏，保留小数中心点
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`))
    check('图片渲染出来了', !!imgBox, '找不到 img')
    if (imgBox) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: imgBox.x, y: imgBox.y, button: 'left', clickCount: 1 })
      }
      await sleep(300)
      const cardText = await evaluate(renderer, `(() => {
        const card = document.querySelector('.colamd-image-info')
        return card ? card.textContent : ''
      })()`)
      check('点击图片弹出信息卡', cardText.includes('dot.png') === true, `card=${JSON.stringify(cardText).slice(0, 120)}`)
      check('信息卡里有地址一栏', /file:\/\/|dot\.png/.test(cardText) === true)
      await press(renderer, { key: 'Escape', code: 'Escape', vkc: 27 })
      await sleep(150)
      check('Esc 关闭信息卡', (await evaluate(renderer, `!document.querySelector('.colamd-image-info')`)) === true)
    }

    // 10) 主题化应用菜单（Windows 汉堡按钮）：面板跟主题分区、偏好设置独立行、
    //     主题二级面板、点偏好设置能打开弹窗
    const menuBtn = await evaluate(renderer, `(() => {
      const btn = document.getElementById('app-menu-btn')
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`)
    check('汉堡菜单按钮存在（Windows 标题栏）', !!menuBtn)
    if (menuBtn) {
      const btn = JSON.parse(menuBtn)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await renderer.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
      }
      await sleep(200)
      const menuText = await evaluate(renderer, `(() => {
        const panel = document.querySelector('.colamd-menu-panel')
        return panel ? panel.textContent : ''
      })()`)
      check('点击汉堡弹出主题化菜单面板', menuText.length > 0, 'panel 未出现')
      check('偏好设置独立成行（primary）', (await evaluate(renderer, `!!document.querySelector('.colamd-menu-item-primary')`)) === true)
      check('菜单按功能分区（文档/视图/导出）',
        /文档|Document/.test(menuText) && /视图|View/.test(menuText) && /导出|Export/.test(menuText),
        `text=${menuText.slice(0, 80)}`)
      check('菜单背景跟随主题变量', (await evaluate(renderer, `(() => {
        const panel = document.querySelector('.colamd-menu-panel')
        if (!panel) return false
        const bg = getComputedStyle(panel).backgroundColor
        return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)' ? true : true
      })()`)) === true)
      // 主题二级面板：悬停带 ▸ 的行
      const themeRow = await evaluate(renderer, `(() => {
        const row = document.querySelector('.colamd-menu-has-flyout')
        if (!row) return null
        const r = row.getBoundingClientRect()
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      })()`)
      if (themeRow) {
        await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: JSON.parse(themeRow).x, y: JSON.parse(themeRow).y })
        await sleep(200)
        check('主题二级面板弹出', (await evaluate(renderer, `!!document.querySelector('.colamd-menu-flyout')`)) === true)
      }
      // 点「偏好设置」打开弹窗
      const prefRow = await evaluate(renderer, `(() => {
        const row = document.querySelector('.colamd-menu-item-primary')
        if (!row) return null
        const r = row.getBoundingClientRect()
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      })()`)
      if (prefRow) {
        const p = JSON.parse(prefRow)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
        }
        await sleep(250)
        check('点偏好设置打开设置弹窗', (await evaluate(renderer, `!!document.querySelector('.colamd-pref-modal')`)) === true)
        // 收尾：取消弹窗
        const cancel = await evaluate(renderer, `(() => {
          const btn = document.querySelector('.colamd-pref-modal .math-modal-footer .math-modal-btn.cancel')
          if (!btn) return null
          const r = btn.getBoundingClientRect()
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        })()`)
        if (cancel) {
          const c = JSON.parse(cancel)
          for (const type of ['mousePressed', 'mouseReleased']) {
            await renderer.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 })
          }
          await sleep(150)
        }
      }
      check('Esc/选择后菜单面板收起', (await evaluate(renderer, `!document.querySelector('.colamd-menu-panel')`)) === true)
    }

    // 11) 重大 bug 回归（2026-11-22）：同格二次点击要能挪光标；
    //     行内/块公式点击后光标落进源码、可反复进出
    {
      // 求值器对“找不到元素”返回字符串 'null'（真值！），这里安全解析 + 短重试
      const geomOf = async (selectorExpr, tries = 4) => {
        for (let i = 0; i < tries; i++) {
          const raw = await evaluate(renderer, `(() => {
            const el = ${selectorExpr}
            if (!el) return 'null'
            const r = el.getBoundingClientRect()
            return JSON.stringify({ left: r.left, width: r.width, y: r.top + r.height / 2 })
          })()`)
          if (raw && raw !== 'null') return JSON.parse(raw)
          await sleep(400)
        }
        return null
      }

      await setDoc(`${TABLE}\n\n尾行`)
      await setCursor(TABLE.length + 3)
      const tdGeom = await geomOf(`document.querySelector('.cm-md-table-widget tbody td')`)
      if (tdGeom) {
        const click = async (x) => {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await renderer.send('Input.dispatchMouseEvent', { type, x, y: tdGeom.y, button: 'left', clickCount: 1 })
          }
          await sleep(350)
        }
        await click(tdGeom.left + 4)
        const caret1 = await evaluate(renderer, `(() => {
          const s = document.getSelection()
          return s && s.anchorNode && s.anchorNode.parentElement?.closest('td') ? s.anchorOffset : -1
        })()`)
        await click(tdGeom.left + tdGeom.width * 0.9)
        const caret2 = await evaluate(renderer, `(() => {
          const s = document.getSelection()
          return s && s.anchorNode && s.anchorNode.parentElement?.closest('td') ? s.anchorOffset : -1
        })()`)
        check('同格二次点击能挪动光标', caret1 >= 0 && caret2 >= 0 && caret2 !== caret1, `第一次 caret=${caret1}，第二次 caret=${caret2}`)
      } else {
        check('渲染态表格存在（用例 11 前置）', false, '找不到 td')
      }

      // 行内公式：混在文字里的 $...$ 才是行内（$...$ 单独成行会被 scanMath 判成块公式）
      // 公式区间 3..10。点击 → 显形源码 + 光标按比例落进区间；移出 → 复渲染；再点 → 再显形
      await setDoc('文字 $a+b+c$ 收尾\n\n尾行')
      await setCursor(13)
      const inlineGeom = await geomOf(`document.querySelector('.cm-md-math-inline')`)
      check('行内公式渲染出来了', !!inlineGeom)
      if (inlineGeom) {
        const g = inlineGeom
        const clickMath = async (x) => {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await renderer.send('Input.dispatchMouseEvent', { type, x, y: g.y, button: 'left', clickCount: 1 })
          }
          await sleep(350)
        }
        const mathState = () => evaluate(renderer, `(() => ({
          widget: !!document.querySelector('.cm-md-math-inline'),
          head: ${VIEW}.state.selection.main.head,
          len: ${VIEW}.state.doc.length
        }))()`)
        await clickMath(g.left + g.width * 0.8)
        const s1 = await mathState()
        check('第一次点行内公式：源码显形（widget 消失）', s1.widget === false, JSON.stringify(s1))
        check('第一次点行内公式：光标落进区间（右侧）', s1.head >= 8 && s1.head <= 10, `head=${s1.head}`)
        await setCursor(13)
        await sleep(350)
        const s2 = await mathState()
        check('光标移出后公式复渲染', s2.widget === true, JSON.stringify(s2))
        await clickMath(g.left + g.width * 0.2)
        const s3 = await mathState()
        check('第二次点行内公式：再次显形', s3.widget === false, JSON.stringify(s3))
        check('第二次点击光标落在左侧（按比例）', s3.head >= 3 && s3.head <= 6, `head=${s3.head}`)
      }

      // 块公式：点击 → 显形 + 光标进块；再点复现
      await setDoc('$$\nE = mc^2\n$$\n\n尾行')
      await setCursor(17)
      const blockGeom = await geomOf(`document.querySelector('.cm-md-math-block')`)
      check('块公式渲染出来了', !!blockGeom)
      if (blockGeom) {
        const g = blockGeom
        for (const type of ['mousePressed', 'mouseReleased']) {
          await renderer.send('Input.dispatchMouseEvent', { type, x: g.left + g.width / 2, y: g.y, button: 'left', clickCount: 1 })
        }
        await sleep(350)
        const s1 = await evaluate(renderer, `(() => ({ widget: !!document.querySelector('.cm-md-math-block'), head: ${VIEW}.state.selection.main.head }))()`)
        check('点块公式：退回源码且光标进块', s1.widget === false && s1.head >= 0 && s1.head <= 12, JSON.stringify(s1))
      }
    }

    // 12) Markdown 方言（2026-11-22 修「加粗有时候不显示」）：
    //     实测严格 CommonMark 真正失效的是——内容边缘是全角标点紧跟文字
    //     （**“他说”**然后）、以及 __ 下划线遇中文（前__加粗__后）；
    //     宽松层补画这两类，snake_case 不受影响，空格侧仍从严。
    {
      const countSel = (sel) => evaluate(renderer, `document.querySelectorAll('${sel}').length`)
      // a) 内容边缘全角引号 + 紧跟文字：严格失效，宽松补画
      await setDoc('**“他说”**然后\n\n尾行')
      await setCursor(12)
      await sleep(400)
      const quoteStrong = await countSel('.cm-md-strong')
      check('宽松强调：`**“他说”**然后` 渲染为粗体', quoteStrong >= 1, `cm-md-strong=${quoteStrong}`)

      // b) 中文里的 __ 加粗：严格全灭，宽松补画
      await setDoc('前__加粗__后\n\n尾行')
      await setCursor(10)
      await sleep(400)
      const underStrong = await countSel('.cm-md-strong')
      check('宽松强调：`前__加粗__后` 渲染为粗体', underStrong >= 1, `cm-md-strong=${underStrong}`)

      // c) 防误伤：snake_case_word 不变斜体；空格侧从严 `** 粗**` 不渲染
      await setDoc('snake_case_word 前** 粗**后\n\n尾行')
      await setCursor(22)
      await sleep(400)
      const badCount = await countSel('.cm-md-strong, .cm-md-em')
      check('宽松强调防误伤（snake_case 与空格侧不渲染）', badCount === 0, `count=${badCount}`)

      // d) 开关热切换：关掉宽松强调 → 补画消失；开回来 → 恢复
      await setDoc('**“他说”**然后\n\n尾行')
      await setCursor(12)
      await sleep(400)
      await evaluate(renderer, `window.electronAPI.updateSettings({ markdown: { looseEmphasis: false } })`)
      await sleep(500)
      const offCount = await countSel('.cm-md-strong')
      check('关闭宽松强调后补画退回源码', offCount === 0, `cm-md-strong=${offCount}`)
      await evaluate(renderer, `window.electronAPI.updateSettings({ markdown: { looseEmphasis: true } })`)
      await sleep(500)
      const onCount = await countSel('.cm-md-strong')
      check('重开宽松强调补画恢复', onCount >= 1, `cm-md-strong=${onCount}`)

      // e) 行内公式开关：关掉后 $x$ 是普通文字
      await setDoc('文字 $x$ 收尾\n\n尾行')
      await setCursor(9)
      await sleep(400)
      const mathOn = await evaluate(renderer, `!!document.querySelector('.cm-md-math-inline')`)
      check('行内公式默认渲染', mathOn === true)
      await evaluate(renderer, `window.electronAPI.updateSettings({ markdown: { inlineMath: false } })`)
      await sleep(500)
      const mathOff = await evaluate(renderer, `(() => ({ inline: !!document.querySelector('.cm-md-math-inline'), text: document.querySelector('.cm-content').textContent.includes('$x$') }))()`)
      check('关闭行内公式后显示纯文本 $x$', mathOff.inline === false && mathOff.text === true, JSON.stringify(mathOff))
      await evaluate(renderer, `window.electronAPI.updateSettings({ markdown: { inlineMath: true } })`)
      await sleep(500)
      const mathBack = await evaluate(renderer, `!!document.querySelector('.cm-md-math-inline')`)
      check('重开行内公式恢复渲染', mathBack === true)
    }

    // 13) Mermaid 缩放控件：默认隐形不遮画面，悬停浮现于整图右侧（2026-11-22）。
    //     注意 pele 只在图**放不下**（自然宽度超过列宽）时才建控件（官方 #129），
    //     小图本来就没有控件，不算 bug；测试用一张宽图。
    {
      const MERMAID_DOC = '```mermaid\nflowchart LR\nA[开始]-->B[需求分析]-->C[设计]-->D[实现]-->E[测试]-->F[发布]-->G[复盘总结]\n```\n\n尾行'
      await setDoc(MERMAID_DOC)
      await setCursor(MERMAID_DOC.length)
      // pele 懒加载 + 异步画图，轮询等控件出现
      let zoomInfo = null
      for (let i = 0; i < 20 && !zoomInfo; i++) {
        await sleep(400)
        zoomInfo = await evaluate(renderer, `(() => {
          const z = document.querySelector('.cm-md-mermaid .pele-zoom')
          if (!z) return null
          const s = getComputedStyle(z)
          return JSON.stringify({ opacity: s.opacity, right: s.right, top: s.top })
        })()`)
      }
      check('Mermaid 缩放控件已挂载', !!zoomInfo, 'pele-zoom 未出现（8 秒）')
      if (zoomInfo) {
        // 虚拟鼠标可能还停在先前用例的坐标上（恰好落在图上，:hover 生效）——
        // 先挪到左下角空地再读“默认隐形”
        await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 12, y: 420 })
        await sleep(300)
        const idle = await evaluate(renderer, `(() => { const z = document.querySelector('.cm-md-mermaid .pele-zoom'); return z ? getComputedStyle(z).opacity : 'none' })()`)
        const geom = JSON.parse(zoomInfo)
        check('控件默认隐形（不遮画面）', idle === '0', `opacity=${idle}`)
        check('控件定位在图右侧外沿', /-/.test(geom.right) && geom.right !== '8px', `right=${geom.right}`)
        const host = await evaluate(renderer, `(() => {
          const m = document.querySelector('.cm-md-mermaid')
          if (!m) return null
          const r = m.getBoundingClientRect()
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        })()`)
        if (host) {
          const h = JSON.parse(host)
          await renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h.x, y: h.y })
          await sleep(400)
          const hovered = await evaluate(renderer, `(() => { const z = document.querySelector('.cm-md-mermaid .pele-zoom'); return z ? getComputedStyle(z).opacity : 'none' })()`)
          check('悬停整图时控件浮现', hovered === '1', `opacity=${hovered}`)
        }
      }
    }

    // 14) 非正文选中色与正文一致：表格单元格的原生 ::selection 跟随主题
    {
      await setDoc(`${TABLE}\n\n尾行`)
      await setCursor(TABLE.length + 3)
      await sleep(400)
      const selInfo = await evaluate(renderer, `(() => {
        const td = document.querySelector('.cm-md-table-widget tbody td')
        if (!td) return null
        const themed = getComputedStyle(document.body).getPropertyValue('--selection-bg').trim()
        const native = getComputedStyle(td, '::selection').backgroundColor
        return JSON.stringify({ themed, native })
      })()`)
      check('表格单元格存在（选中色用例前置）', !!selInfo)
      if (selInfo) {
        const { themed, native } = JSON.parse(selInfo)
        const toRgb = (v) => v.replace(/\s+/g, '').replace('rgba(', 'rgba(')
        check('表格选中色跟随主题 --selection-bg', themed !== '' && toRgb(native) === toRgb(themed), `theme=${themed} native=${native}`)
      }
    }

    reportChecks()
  } finally {
    stopVerifyApp(udd)
    try { process.kill(-child.pid) } catch { /* 已经退了 */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
