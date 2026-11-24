// 快捷键改绑验收（ColaMD CT，2026-11-24）。
//
// 起因：用户报「设置内快捷键和菜单栏快捷键不同步，导致某些快捷键使用菜单栏的方法时无反应
// （点击按钮可用）」。实测出三件事：
//   1. 偏好设置里的改绑捕获是坏的：按任何组合都被判成「需含 Ctrl/Cmd 或 Alt 修饰」
//      （捕获函数只返回了键名，丢了修饰键），设置里永远改不动；
//   2. 标题栏模块菜单的提示只读注册表的默认键位，用户改绑后照着提示按没反应；
//   3. 按键层故意放过「纯 Alt+字母/数字」，用户 settings.json 里那套 Alt 系改绑全都不响应；
//      设置页显示的是 `CmdOrCtrl+B`，菜单显示的是 `Ctrl+B`，同一个键看着像两个。
//
// 断言（全程真实按键事件）：
//   A. 带着用户那套 Alt 系改绑启动：每条都响应；模块菜单提示、设置页显示与之同步。
//   B. 偏好设置里用真实按键改绑：捕获得到完整的组合；保存后写入设置；模块菜单提示跟着变；
//      新键生效、旧键失效；冲突的两条都标出来。
//
// 用法: npm run build && node scripts/verify-keybindings.mjs
import { launchApp, reporter, sleep, CTRL, ALT, SHIFT } from './ct-harness.mjs'

const report = reporter('快捷键改绑')
const VK = { a: 65, b: 66, c: 67, d: 68, g: 71, h: 72, i: 73, l: 76, m: 77, u: 85, '1': 49, '0': 48, '6': 54 }
const codeOf = (key) => (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`)
/** 按 `Ctrl+Shift+X` 这种写法的键。字母键带 Shift 时 key 用大写（和真实键盘一致）。 */
const combo = (app, accelerator) => {
  const parts = accelerator.split('+')
  const key = parts.pop().toLowerCase()
  const mods = (parts.some((part) => /ctrl|cmd/i.test(part)) ? CTRL : 0) | (parts.some((part) => /alt/i.test(part)) ? ALT : 0) | (parts.some((part) => /shift/i.test(part)) ? SHIFT : 0)
  const shifted = mods & SHIFT && /^[a-z]$/.test(key)
  return app.press(codeOf(key), shifted ? key.toUpperCase() : key, VK[key] ?? key.toUpperCase().charCodeAt(0), mods)
}
const hintsOf = async (app, ...labels) => {
  await app.ev(`document.getElementById('app-menu-btn-format').click()`)
  await sleep(300)
  const items = JSON.parse(await app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].map((row) => ({ label: (row.querySelector('.colamd-menu-label')?.textContent ?? '').trim(), hint: (row.querySelector('.colamd-menu-hint')?.textContent ?? '').trim() })).filter((item) => ${JSON.stringify(labels)}.includes(item.label)))`))
  await app.ev(`document.getElementById('app-menu-btn-format').click()`)
  await sleep(200)
  return Object.fromEntries(items.map((item) => [item.label, item.hint]))
}

// ─── A：带着用户那套 Alt 系改绑启动 ──────────────────────────────────────────
{
  const USER_BINDINGS = {
    bold: 'Alt+B', italic: 'Alt+I', underline: 'Alt+U', inlineCode: 'Alt+C', strikethrough: 'Alt+D', highlight: 'Alt+H',
    heading1: 'Alt+1', heading6: 'Alt+6', paragraph: 'Alt+0', codeBlock: 'Shift+Alt+C', mathBlock: 'Shift+Alt+M',
  }
  const app = await launchApp('ct-keybindings-alt', { settings: { keybindings: USER_BINDINGS } })
  try {
    console.log('一、用户 settings.json 里的 Alt 系改绑')
    const INLINE = ['bold', 'italic', 'underline', 'inlineCode', 'strikethrough', 'highlight']
    const TAIL = '\n\n尾'
    const WANT = {
      bold: '**甲乙**丙', italic: '*甲乙*丙', underline: '<u>甲乙</u>丙', inlineCode: '`甲乙`丙', strikethrough: '~~甲乙~~丙', highlight: '==甲乙==丙',
      heading1: '# 甲乙丙', heading6: '###### 甲乙丙',
    }
    for (const [id, accelerator] of Object.entries(USER_BINDINGS)) {
      // 行内命令用选区；「正文」要拿一行标题来降级；其余把光标放在行首
      const base = id === 'paragraph' ? `# 甲乙丙${TAIL}` : `甲乙丙${TAIL}`
      await app.setDoc(base)
      await app.select(...(INLINE.includes(id) ? [0, 2] : [0]))
      await combo(app, accelerator)
      const after = await app.doc()
      const ok = id === 'paragraph' ? after === `甲乙丙${TAIL}` : id === 'codeBlock' ? after.includes('```') : id === 'mathBlock' ? after.includes('$$') : after === WANT[id] + TAIL
      report.check(`A 按键 ${accelerator.padEnd(12)} → ${id}`, ok, JSON.stringify(after))
    }
    const hints = await hintsOf(app, '加粗', '斜体', '行内代码', '代码块', '公式块')
    report.check('A 模块菜单提示跟着改绑走（加粗 Alt+B、代码块 Alt+Shift+C、公式块 Alt+Shift+M）',
      hints['加粗'] === 'Alt+B' && hints['斜体'] === 'Alt+I' && hints['行内代码'] === 'Alt+C' && hints['代码块'] === 'Alt+Shift+C' && hints['公式块'] === 'Alt+Shift+M', JSON.stringify(hints))

    // 偏好设置的改绑列表显示的也是同一个写法
    await app.ev(`document.getElementById('app-menu-btn-more').click()`)
    await sleep(300)
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').includes('偏好设置')); row.click(); return true })()`)
    await sleep(500)
    await app.ev(`(() => { const item = [...document.querySelectorAll('.colamd-pref-nav-item')].find((button) => /快捷键|Shortcut/i.test(button.textContent)); item.click(); return true })()`)
    await sleep(200)
    const shown = JSON.parse(await app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-pref-key-row')].filter((row) => ['加粗', '代码块', '公式块'].includes(row.querySelector('.colamd-pref-key-name').textContent)).map((row) => [row.querySelector('.colamd-pref-key-name').textContent, row.querySelector('.colamd-pref-key-binding').textContent]))`))
    report.check('A 偏好设置里的写法与菜单一致（Alt+B / Alt+Shift+C / Alt+Shift+M）', JSON.stringify(shown) === JSON.stringify([['加粗', 'Alt+B'], ['代码块', 'Alt+Shift+C'], ['公式块', 'Alt+Shift+M']]), JSON.stringify(shown))
  } finally {
    app.stop()
  }
}

// ─── B：在偏好设置里用真实按键改绑 ──────────────────────────────────────────
{
  const app = await launchApp('ct-keybindings')
  try {
    console.log('二、偏好设置里改绑')
    const bindingOf = (label) => app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-pref-key-row')].find((r) => r.querySelector('.colamd-pref-key-name')?.textContent === ${JSON.stringify(label)}); return row ? row.querySelector('.colamd-pref-key-binding').textContent : null })()`)
    const conflictOf = (label) => app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-pref-key-row')].find((r) => r.querySelector('.colamd-pref-key-name')?.textContent === ${JSON.stringify(label)}); return row ? row.querySelector('.colamd-pref-key-binding').classList.contains('conflict') : null })()`)
    const clickBinding = (label) => app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-pref-key-row')].find((r) => r.querySelector('.colamd-pref-key-name')?.textContent === ${JSON.stringify(label)}); const button = row && row.querySelector('.colamd-pref-key-binding'); if (!button) return false; button.focus(); button.click(); return true })()`)
    const before = await hintsOf(app, '加粗')
    report.check('B 默认：模块菜单提示加粗 Ctrl+B', before['加粗'] === 'Ctrl+B', JSON.stringify(before))

    await app.ev(`document.getElementById('app-menu-btn-more').click()`)
    await sleep(300)
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').includes('偏好设置')); row.click(); return true })()`)
    await sleep(500)
    await app.ev(`(() => { const item = [...document.querySelectorAll('.colamd-pref-nav-item')].find((button) => /快捷键|Shortcut/i.test(button.textContent)); item.click(); return true })()`)
    await sleep(200)
    report.check('B 设置页的默认键位写成人看的形式（Ctrl+B，不是 CmdOrCtrl+B）', (await bindingOf('加粗')) === 'Ctrl+B', String(await bindingOf('加粗')))

    // B1：没有修饰键的组合：提示之后继续等，原来的键位还看得见
    await clickBinding('加粗')
    await combo(app, 'g')
    report.check('B1 只按一个字母：提示「需含修饰键」，捕获没有结束', (await bindingOf('加粗')) === '需含 Ctrl/Cmd 或 Alt 修饰', String(await bindingOf('加粗')))
    // B2：接着按 Ctrl+Shift+6：捕获到完整的组合
    await combo(app, 'Ctrl+Shift+6')
    report.check('B2 再按 Ctrl+Shift+6：捕获到完整的组合', (await bindingOf('加粗')) === 'Ctrl+Shift+6', String(await bindingOf('加粗')))
    // B3：换一个：Ctrl+G
    await clickBinding('加粗')
    await combo(app, 'Ctrl+G')
    report.check('B3 捕获 Ctrl+G', (await bindingOf('加粗')) === 'Ctrl+G', String(await bindingOf('加粗')))
    // B4：把斜体也绑到 Ctrl+G → 两条都标成冲突（按归一后的键比）
    await clickBinding('斜体')
    await combo(app, 'Ctrl+G')
    report.check('B4 斜体也绑到 Ctrl+G：两条都标出冲突', (await conflictOf('加粗')) === true && (await conflictOf('斜体')) === true)
    await clickBinding('斜体')
    // B5：退格 = 解绑
    await app.press('Backspace', 'Backspace', 8)
    report.check('B5 退格：解绑，显示「未绑定」', (await bindingOf('斜体')) !== 'Ctrl+G' && (await conflictOf('加粗')) === false, String(await bindingOf('斜体')))

    // 保存
    await app.ev(`(() => { const save = [...document.querySelectorAll('.colamd-pref-footer .math-modal-btn')].find((button) => /保存|Save/.test(button.textContent)); save.click(); return true })()`)
    await sleep(600)
    const settings = JSON.parse(await app.ev(`window.electronAPI.getSettings().then((value) => JSON.stringify(value.keybindings))`))
    report.check('B6 保存后写进设置（平台中立的 CmdOrCtrl+G）', settings.bold === 'CmdOrCtrl+G', JSON.stringify(settings))

    const hints = await hintsOf(app, '加粗', '斜体')
    report.check('B7 保存后模块菜单提示跟着变（加粗 Ctrl+G，斜体不再有提示）', hints['加粗'] === 'Ctrl+G' && hints['斜体'] === '', JSON.stringify(hints))

    // 新键生效、旧键失效
    await app.setDoc('甲乙丙\n\n尾')
    await app.select(0, 2)
    await combo(app, 'Ctrl+G')
    report.check('B8 新键 Ctrl+G：加粗', (await app.doc()) === '**甲乙**丙\n\n尾', JSON.stringify(await app.doc()))
    await app.setDoc('甲乙丙\n\n尾')
    await app.select(0, 2)
    await combo(app, 'Ctrl+B')
    report.check('B8 旧键 Ctrl+B：不再触发加粗', (await app.doc()) === '甲乙丙\n\n尾', JSON.stringify(await app.doc()))
    await app.setDoc('甲乙丙\n\n尾')
    await app.select(0, 2)
    await combo(app, 'Ctrl+I')
    report.check('B8 解绑的斜体（Ctrl+I）不响应', (await app.doc()) === '甲乙丙\n\n尾', JSON.stringify(await app.doc()))

    // 模块菜单里点「加粗」仍然有效（两条入口同一个动作）。
    // 先重置选区：上一步的 Ctrl+I 没被应用拦下，落到了 CodeMirror 自带的「选中所在语法节点」，选区被扩开了
    await app.setDoc('甲乙丙\n\n尾')
    await app.select(0, 2)
    await app.ev(`document.getElementById('app-menu-btn-format').click()`)
    await sleep(300)
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === '加粗'); row.click(); return true })()`)
    await sleep(250)
    report.check('B9 点模块菜单里的「加粗」照常生效', (await app.doc()) === '**甲乙**丙\n\n尾', JSON.stringify(await app.doc()))
    report.check('B10 保存后偏好设置弹窗关了（没有残留）', (await app.ev(`document.querySelectorAll('.colamd-pref-key-row').length`)) === 0)
  } finally {
    app.stop()
  }
}
report.summary()
