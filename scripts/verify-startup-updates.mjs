// 启动行为三选项 + 应用内更新横幅验收（ColaMD CT，2026-11-25，v2.7.25）。
//
// 用户要求：① 偏好设置里「每次打开时」可选 新建文件 / 打开上次会话的所有文件 /
// 显示欢迎界面；② 菜单里的「检查更新…」→ 自动下载 → 进度条 → 一键重启安装。
//
// 断言：
//   一、会话恢复（restore）：第一轮保存文档 → 关窗 → 二次启动（复用 profile、
//       不带文件参数）→ 上次的文档原样回来（recent.json 的 lastSessionTabs）；
//   二、欢迎界面（welcome）：二次启动弹欢迎层、最近文档可点、新建/Esc 收起；
//   三、新建文件（blank）：二次启动无欢迎层、文档是默认欢迎内容；
//   四、更新横幅（ct-debug:update-event 驱动，无头环境没有真 feed）：发现新版本
//       → 按钮置灰显示下载中 → 进度百分比 → 已就绪一键重启安装 → 关闭收起；
//   五、菜单与偏好设置：帮助/更多 都有 检查更新…，文件菜单的 启动时 三选项，
//       偏好设置的启动下拉改一下真的写进设置。
//
// 用法: npm run build && node scripts/verify-startup-updates.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, reporter, sleep } from './ct-harness.mjs'
import { VERIFY_ROOT } from './verify-workdir.mjs'

const report = reporter('启动行为与更新横幅')
const profileDir = (name) => join(VERIFY_ROOT, name)
const recentJson = (name) => JSON.parse(readFileSync(join(profileDir(name), 'udd-main', 'recent.json'), 'utf8'))
const welcomeHidden = (app) => app.ev(`document.getElementById('welcome-screen').hidden`)
const bannerHidden = (app) => app.ev(`document.getElementById('update-banner').hidden`)
const bannerText = (app) => app.ev(`document.getElementById('update-banner-text').textContent`)
const bannerAction = (app) => app.ev(`(() => { const b = document.getElementById('update-banner-action'); return b.textContent + '|' + (b.disabled ? 'disabled' : 'enabled') })()`)
/** 关窗（走正常关闭守卫 → 'closed' → 持久化会话）。窗口一关 CDP 连接跟着断，
 * 这个调用可能既不成功也不失败——用超时竞速走过去，关窗本身照常发生。 */
const closeWindowTolerant = async (app) => {
  await Promise.race([
    app.ev(`window.electronAPI.closeWindow()`).catch(() => null),
    sleep(3000),
  ])
  await sleep(1500)
}

// ─── 一、会话恢复（restore） ──────────────────────────────────────────────────
{
  const NAME = 'ct-startup-restore'
  const app1 = await launchApp(NAME)
  try {
    console.log('一、会话恢复（restore）')
    await app1.setDoc('恢复会话验证\n')
    await app1.ev(`window.electronAPI.appMenuAction('menu-save')`)
    await sleep(700)
    await app1.ev(`window.electronAPI.setStartupMode('restore')`)
    await closeWindowTolerant(app1)
    app1.stop()
  } finally {
    app1.stop()
  }
  const store = recentJson(NAME)
  report.check('关窗后 lastSessionTabs 记下了 doc.md', Array.isArray(store.lastSessionTabs) && store.lastSessionTabs.some((p) => p.endsWith('doc.md')), JSON.stringify(store))
  report.check('startup 已写成 restore', store.startup === 'restore', String(store.startup))

  const app2 = await launchApp(NAME, { reuse: true, noDoc: true })
  try {
    let restored = ''
    for (let i = 0; i < 20; i++) {
      restored = await app2.doc()
      if (restored === '恢复会话验证\n') break
      await sleep(300)
    }
    report.check('二次启动：上次的文档原样回来（启动分支，不是命令行文件）', restored === '恢复会话验证\n', JSON.stringify(restored))
    report.check('二次启动：欢迎层没有弹', (await welcomeHidden(app2)) === true)
  } finally {
    app2.stop()
  }
}

// ─── 二、欢迎界面（welcome） ─────────────────────────────────────────────────
{
  const NAME = 'ct-startup-welcome'
  const app1 = await launchApp(NAME)
  try {
    console.log('二、欢迎界面（welcome）')
    // 造一条最近记录，欢迎层上才有东西可点
    await app1.setDoc('欢迎界面验证\n')
    await app1.ev(`window.electronAPI.appMenuAction('menu-save')`)
    await sleep(700)
    await app1.ev(`window.electronAPI.setStartupMode('welcome')`)
    await closeWindowTolerant(app1)
  } finally {
    app1.stop()
  }

  const app2 = await launchApp(NAME, { reuse: true, noDoc: true })
  try {
    let visible = null
    for (let i = 0; i < 20; i++) {
      visible = await app2.ev(`(() => { const el = document.getElementById('welcome-screen'); return el ? !el.hidden : null })()`)
      if (visible === true) break
      await sleep(300)
    }
    report.check('二次启动（welcome）：欢迎层弹出来了', visible === true, String(visible))
    const items = await app2.ev(`document.querySelectorAll('#welcome-recent-list .welcome-recent-item').length`)
    report.check('欢迎层列出最近文档', items >= 1, `count=${items}`)
    const titles = await app2.ev(`JSON.stringify({ title: document.querySelector('.welcome-title')?.textContent, recent: document.querySelector('.welcome-recent-title')?.textContent })`)
    report.check('欢迎层文案齐（标题/最近文档）', JSON.parse(titles).title === '欢迎使用 ColaMD CT' && JSON.parse(titles).recent === '最近的文档', titles)
    await app2.ev(`document.getElementById('welcome-new-btn').click()`)
    await sleep(300)
    report.check('点「新建文档」：欢迎层收起', (await welcomeHidden(app2)) === true)
  } finally {
    app2.stop()
  }

  const app3 = await launchApp(NAME, { reuse: true, noDoc: true })
  try {
    await sleep(1500)
    report.check('再启动一次：欢迎层还在（模式持久）', (await welcomeHidden(app3)) === false)
    await app3.press('Escape', 'Escape', 27)
    await sleep(300)
    report.check('按 Esc：欢迎层收起', (await welcomeHidden(app3)) === true)
  } finally {
    app3.stop()
  }
}

// ─── 三、新建文件（blank） ───────────────────────────────────────────────────
{
  const NAME = 'ct-startup-blank'
  const app1 = await launchApp(NAME)
  try {
    console.log('三、新建文件（blank）')
    await app1.setDoc('空白启动验证\n')
    await app1.ev(`window.electronAPI.appMenuAction('menu-save')`)
    await sleep(700)
    await app1.ev(`window.electronAPI.setStartupMode('blank')`)
    await closeWindowTolerant(app1)
  } finally {
    app1.stop()
  }
  const store = recentJson(NAME)
  report.check('blank 模式下 lastSessionTabs 仍有记录（但不恢复）', Array.isArray(store.lastSessionTabs) && store.lastSessionTabs.length >= 1, JSON.stringify(store.lastSessionTabs))

  const app2 = await launchApp(NAME, { reuse: true, noDoc: true })
  try {
    await sleep(1500)
    report.check('blank 启动：欢迎层不弹', (await welcomeHidden(app2)) === true)
    const doc = await app2.doc()
    report.check('blank 启动：文档是默认欢迎内容（不是上次的文件）', doc.startsWith('# **欢迎使用 ColaMD CT**'), JSON.stringify(doc.slice(0, 30)))
  } finally {
    app2.stop()
  }
}

// ─── 四、更新横幅（调试钩子驱动状态机） ─────────────────────────────────────
{
  const app = await launchApp('ct-update-banner')
  try {
    console.log('四、更新横幅')
    await app.ev(`window.electronAPI.ctDebugUpdateEvent('available', '9.9.9')`)
    await sleep(300)
    report.check('发现新版本：横幅出现、文本带版本号', (await bannerHidden(app)) === false && (await bannerText(app)).includes('9.9.9'), await bannerText(app))
    let action = await bannerAction(app)
    report.check('自动下载已开始：按钮置灰显示「下载中…」', action === '下载中…|disabled', action)
    await app.ev(`window.electronAPI.ctDebugUpdateEvent('progress', 55)`)
    await sleep(300)
    action = await bannerAction(app)
    report.check('进度打到按钮上（下载中 55%）', action === '下载中 55%|disabled', action)
    await app.ev(`window.electronAPI.ctDebugUpdateEvent('downloaded', '9.9.9')`)
    await sleep(300)
    action = await bannerAction(app)
    report.check('下载完成：一键「重启安装」（可点）', action === '重启安装|enabled', action)
    report.check('文本切到「已就绪」', (await bannerText(app)).includes('已就绪'), await bannerText(app))
    // 失败重试路径
    await app.ev(`window.electronAPI.ctDebugUpdateEvent('available', '9.9.9')`)
    await app.ev(`window.electronAPI.ctDebugUpdateEvent('error')`)
    await sleep(300)
    action = await bannerAction(app)
    report.check('下载失败：按钮变「点击重试」（可点）', action === '下载失败，点击重试|enabled', action)
    await app.ev(`document.getElementById('update-banner-dismiss').click()`)
    await sleep(200)
    report.check('关闭横幅收起', (await bannerHidden(app)) === true)
  } finally {
    app.stop()
  }
}

// ─── 五、菜单与偏好设置 ─────────────────────────────────────────────────────
{
  const app = await launchApp('ct-startup-menus')
  try {
    console.log('五、菜单与偏好设置')
    const spec = JSON.parse(await app.ev(`window.electronAPI.getMenuSpec().then((value) => JSON.stringify(value))`))
    const help = spec.find((entry) => entry.label === '帮助')
    const checkItem = help && help.items.find((item) => item.label === '检查更新...')
    report.check('原生 帮助→检查更新… 存在且有 click', !!checkItem && checkItem.hasClick, JSON.stringify(checkItem))
    const file = spec.find((entry) => entry.label === '文件')
    const startupItem = file && file.items.find((item) => item.label === '启动时')
    report.check('原生 文件→启动时 子菜单存在', !!startupItem && startupItem.hasSubmenu, JSON.stringify(startupItem))

    // 更多模块的检查更新
    await app.ev(`document.getElementById('app-menu-btn-more').click()`)
    await sleep(300)
    const moreLabels = await app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].map((row) => (row.querySelector('.colamd-menu-label')?.textContent ?? '').trim()))`)
    report.check('更多模块：检查更新… 条目存在', JSON.parse(moreLabels).includes('检查更新…'), moreLabels)
    await app.ev(`document.getElementById('app-menu-btn-more').click()`)
    await sleep(200)

    // 文件模块 启动时 三选项（悬停展开）
    await app.ev(`document.getElementById('app-menu-btn-file').click()`)
    await sleep(300)
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === '启动时'); row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return true })()`)
    await sleep(350)
    const startupLabels = await app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-menu-flyout .colamd-menu-item')].map((row) => ({ label: (row.querySelector('.colamd-menu-label')?.textContent ?? '').trim(), checked: !!row.querySelector('.colamd-menu-check') })))`)
    const parsed = JSON.parse(startupLabels)
    const labels = parsed.map((entry) => entry.label)
    report.check('启动时 三选项齐全（新建/恢复会话/欢迎）',
      ['新建文件', '打开上次会话的所有文件', '显示欢迎界面'].every((label) => labels.includes(label)), startupLabels)
    const checkedOne = parsed.filter((entry) => entry.checked)
    report.check('启动时 恰好勾选一项（fresh profile 迁移默认 restore）', checkedOne.length === 1 && checkedOne[0].label === '打开上次会话的所有文件', JSON.stringify(checkedOne))
    await app.ev(`document.getElementById('app-menu-btn-file').click()`)
    await sleep(200)

    // IPC 往返
    const before = await app.ev(`window.electronAPI.getStartupMode()`)
    await app.ev(`window.electronAPI.setStartupMode('welcome')`)
    await sleep(300)
    const after = await app.ev(`window.electronAPI.getStartupMode()`)
    await app.ev(`window.electronAPI.setStartupMode(${JSON.stringify(before)})`)
    report.check('get/set-startup-mode 往返', after === 'welcome', `${before} → ${after}`)

    // 偏好设置面板的启动下拉
    await app.ev(`document.getElementById('app-menu-btn-more').click()`)
    await sleep(300)
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').includes('偏好设置')); row.click(); return true })()`)
    await sleep(500)
    const selectOk = await app.ev(`(() => { const options = [...document.querySelectorAll('.math-modal select option')].filter((option) => ['blank', 'restore', 'welcome'].includes(option.value)); return options.length === 3 ? options.map((option) => option.value).join(',') : null })()`)
    report.check('偏好设置：启动下拉三选项（编辑器页）', selectOk === 'blank,restore,welcome', String(selectOk))
    const changed = await app.ev(`(() => { const select = [...document.querySelectorAll('.math-modal select')].find((s) => [...s.options].some((o) => o.value === 'welcome')); if (!select) return null; select.value = 'welcome'; select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await sleep(400)
    report.check('偏好设置里改选「显示欢迎界面」→ 写进设置', changed === true && (await app.ev(`window.electronAPI.getStartupMode()`)) === 'welcome', await app.ev(`window.electronAPI.getStartupMode()`))
    await app.ev(`window.electronAPI.setStartupMode('restore')`)
  } finally {
    app.stop()
  }
}
report.summary()
