// 菜单齐全度验收（ColaMD CT，2026-11-25）。
//
// 起因：用户报「macOS 的『查找』在菜单栏能找到，Windows 的没有」。根源不是快捷键
// （Ctrl+F 一直有 DOM 兜底），而是两套菜单各画各的：macOS 用户看到的是完整原生
// 菜单，Windows 用户看到的是左侧模块面板——它是原生菜单的子集且已漂移（查找、
// 撤销/剪切复制粘贴、替换、导出幻灯片 PDF、清除最近记录、编辑器字体、自定义主题、
// 关于……全都没有可见入口）。
//
// 断言：
//   一、六个模块面板的条目齐全度（含二级面板），与原生菜单对齐；
//   二、查找三件套（查找/下一个/上一个/替换）从模块菜单端到端可用；
//   三、真实按键：F3 / Shift+F3 / Ctrl+G / Ctrl+Shift+G / Ctrl+H / Escape；
//   四、编辑模块的撤销/重做/剪切/复制/粘贴/全选（主进程编辑命令 + CM 历史）；
//   五、原生菜单快照（getMenuSpec）：编辑菜单有查找三件套、非 mac 的「关于」不再是
//       哑的 role、文件菜单有清除最近记录/启动开关/幻灯片导出；
//   六、Windows 系统字体枚举非空（字体设置下拉此前一直是空的）。
//
// 用法: npm run build && node scripts/verify-menu-parity.mjs
import { launchApp, reporter, sleep, CTRL, SHIFT } from './ct-harness.mjs'

const report = reporter('菜单齐全度')

const VK = { f: 70, g: 71, h: 72, x: 88 }
const pressKey = (app, code, key, vk, mods = 0) => app.press(code, key, vk, mods)

/** 打开某个模块面板，返回顶层条目的 label 列表。面板保持打开（调用方负责收起）。 */
const openModule = async (app, module) => {
  await app.ev(`document.getElementById('app-menu-btn-${module}').click()`)
  await sleep(300)
  return app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].map((row) => (row.querySelector('.colamd-menu-label')?.textContent ?? '').trim()))`)
}
const closeModule = async (app, module) => {
  await app.ev(`document.getElementById('app-menu-btn-${module}').click()`)
  await sleep(200)
}
/** 点模块面板里的一条（按 label 文本找）。 */
const clickItem = async (app, module, label) => {
  await app.ev(`document.getElementById('app-menu-btn-${module}').click()`)
  await sleep(300)
  const clicked = await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === ${JSON.stringify(label)}); if (!row) return false; row.click(); return true })()`)
  await sleep(350)
  return clicked
}
/** 悬停展开某个带二级面板的条目，返回二级条目 label 列表（面板保持打开）。 */
const hoverItem = async (app, module, label) => {
  await openModule(app, module)
  await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === ${JSON.stringify(label)}); if (!row) return false; row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return true })()`)
  await sleep(350)
  const labels = await app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-menu-flyout .colamd-menu-item')].map((row) => (row.querySelector('.colamd-menu-label')?.textContent ?? '').trim()))`)
  await closeModule(app, module)
  return labels
}
const labelsInclude = (labels, want) => {
  const missing = want.filter((label) => !labels.includes(label))
  return { ok: missing.length === 0, missing }
}

// ─── 一 + 五：齐全度 ──────────────────────────────────────────────────────────
{
  const app = await launchApp('ct-menu-parity')
  try {
    console.log('一、六个模块面板的条目齐全度')

    // 编辑模块：与 macOS 原生「编辑」菜单一一对应
    const editLabels = await openModule(app, 'edit')
    let verdict = labelsInclude(JSON.parse(editLabels), ['撤销', '重做', '剪切', '复制', '粘贴', '全选', '查找', '查找下一个', '查找上一个', '替换'])
    report.check('编辑模块：撤销/重做/剪贴板四件套/查找三件套齐全', verdict.ok, verdict.ok ? editLabels : `缺 ${JSON.stringify(verdict.missing)}：${editLabels}`)
    await closeModule(app, 'edit')

    // 文件模块：启动开关、导出幻灯片 PDF（此前只有原生菜单有）
    const fileLabels = await openModule(app, 'file')
    verdict = labelsInclude(JSON.parse(fileLabels), ['启动时打开上次文档', '最近打开'])
    report.check('文件模块：启动时打开上次文档 / 最近打开齐全', verdict.ok, verdict.ok ? fileLabels : `缺 ${JSON.stringify(verdict.missing)}`)
    await closeModule(app, 'file')
    const exportLabels = await hoverItem(app, 'file', '导出为…')
    verdict = labelsInclude(JSON.parse(exportLabels), ['PDF', 'HTML', 'Word', '图片（电脑阅读）', '图片（手机阅读）', '导出幻灯片 PDF…'])
    report.check('文件模块：导出子菜单六项齐全（含导出幻灯片 PDF…）', verdict.ok, verdict.ok ? exportLabels : `缺 ${JSON.stringify(verdict.missing)}：${exportLabels}`)

    // 格式模块：标题子菜单带提升/降低（注册表里有命令、有默认键，此前漏画）
    const headingLabels = await hoverItem(app, 'format', '标题')
    verdict = labelsInclude(JSON.parse(headingLabels), ['一级标题', '六级标题', '正文', '提升标题级别', '降低标题级别'])
    report.check('格式模块：标题子菜单含提升/降低标题级别', verdict.ok, verdict.ok ? headingLabels : `缺 ${JSON.stringify(verdict.missing)}`)
    // 提示要在面板还开着时读（hoverItem 结束时会把面板收掉）
    await openModule(app, 'format')
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === '标题'); row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return true })()`)
    await sleep(350)
    const headingHints = await app.ev(`JSON.stringify([...document.querySelectorAll('.colamd-menu-flyout .colamd-menu-item')].map((row) => [row.querySelector('.colamd-menu-label')?.textContent, row.querySelector('.colamd-menu-hint')?.textContent]))`)
    await closeModule(app, 'format')
    report.check('格式模块：提升/降低的提示来自实时改绑（Alt+= / Alt+-）', JSON.parse(headingHints).some(([label, hint]) => label === '提升标题级别' && hint === 'Alt+='), String(headingHints))

    // 视图模块：编辑器字体、文件列表位置、主题子菜单（自定义 + 导入）
    const viewLabels = await openModule(app, 'view')
    verdict = labelsInclude(JSON.parse(viewLabels), ['Markdown 源码', '文件列表', '文件列表位置', '编辑器字体…', '主题', '正文宽度', '界面语言', '切换全屏'])
    report.check('视图模块：文件列表位置 / 编辑器字体齐全', verdict.ok, verdict.ok ? viewLabels : `缺 ${JSON.stringify(verdict.missing)}`)
    await closeModule(app, 'view')
    const themeLabels = await hoverItem(app, 'view', '主题')
    verdict = labelsInclude(JSON.parse(themeLabels), ['浅色', '德古拉', '导入主题…'])
    report.check('视图模块：主题子菜单含导入主题…', verdict.ok, verdict.ok ? themeLabels : `缺 ${JSON.stringify(verdict.missing)}`)
    const positionLabels = await hoverItem(app, 'view', '文件列表位置')
    verdict = labelsInclude(JSON.parse(positionLabels), ['在左侧', '在右侧'])
    report.check('视图模块：文件列表位置子菜单（在左侧/在右侧）', verdict.ok, verdict.ok ? positionLabels : `缺 ${JSON.stringify(verdict.missing)}`)

    // 更多模块：关于（此前非 mac 的 role about 是哑的）
    const moreLabels = await openModule(app, 'more')
    verdict = labelsInclude(JSON.parse(moreLabels), ['偏好设置…', 'Markdown 语法', '新功能演示', '关于 ColaMD CT…', 'ColaMD CT（项目主页）'])
    report.check('更多模块：关于 ColaMD CT…齐全', verdict.ok, verdict.ok ? moreLabels : `缺 ${JSON.stringify(verdict.missing)}`)
    await closeModule(app, 'more')

    console.log('五、原生菜单快照（getMenuSpec）')
    const spec = JSON.parse(await app.ev(`window.electronAPI.getMenuSpec().then((value) => JSON.stringify(value))`))
    const menuOf = (label) => spec.find((entry) => entry.label === label)
    const edit = menuOf('编辑')
    const itemOf = (menu, label) => menu && menu.items.find((item) => item.label === label)
    report.check('原生 编辑 菜单有查找三件套（Windows 键位 F3 / Shift+F3 / Ctrl+H）',
      ['查找下一个', '查找上一个', '替换'].every((label) => itemOf(edit, label)) && itemOf(edit, '查找下一个').accelerator === 'F3' && itemOf(edit, '查找上一个').accelerator === 'Shift+F3' && itemOf(edit, '替换').accelerator === 'Ctrl+H',
      JSON.stringify(edit && edit.items.filter((item) => /查找|替换/.test(item.label))))
    report.check('原生 编辑 菜单查找三件套都有 click（非 role）',
      ['查找下一个', '查找上一个', '替换'].every((label) => { const item = itemOf(edit, label); return item && item.hasClick && item.role === null }))
    const help = menuOf('帮助')
    const about = itemOf(help, '关于 ColaMD CT')
    report.check('原生 帮助→关于 在非 macOS 是真条目（不再是哑的 role:about）', !!about && about.hasClick, JSON.stringify(about))
    const file = menuOf('文件')
    // 原生菜单的标签用 ASCII 三个点（'导出 PDF...' 同款），模块菜单才是「…」
    report.check('原生 文件 菜单：清除最近记录 / 启动时打开上次文档 / 导出幻灯片 PDF...',
      !!itemOf(file, '清除最近记录') && !!itemOf(file, '启动时打开上次文档') && !!itemOf(file, '导出幻灯片 PDF...'))
    report.check('原生 视图 菜单：编辑器字体… / 文件列表位置（对照，别删）',
      !!itemOf(menuOf('视图'), '编辑器字体…') && !!itemOf(menuOf('视图'), '文件列表位置'))

    console.log('二、查找三件套：模块菜单端到端')
    await app.setDoc('甲乙甲丙甲\n\n尾')
    // 模块菜单点「查找」→ 我们自己的面板打开
    await clickItem(app, 'edit', '查找')
    report.check('编辑→查找：检索面板打开', await app.ev(`getComputedStyle(document.querySelector('.search-panel')).display`) === 'grid', '')
    await app.ev(`(() => { const input = document.querySelector('.search-panel .search-input'); input.value = '甲'; input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(200)
    report.check('面板计数 1/3', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '1/3', String(await app.ev(`document.querySelector('.search-panel .search-count').textContent`)))
    await clickItem(app, 'edit', '查找下一个')
    report.check('编辑→查找下一个：计数 2/3', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '2/3', '')
    await clickItem(app, 'edit', '查找上一个')
    report.check('编辑→查找上一个：计数回到 1/3', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '1/3', '')
    await clickItem(app, 'edit', '替换')
    report.check('编辑→替换：焦点落在替换框', await app.ev(`(() => { const input = document.querySelector('.search-panel .search-replace-input'); return document.activeElement === input })()`), String(await app.ev(`document.activeElement && document.activeElement.className`)))
    // 在替换框里输入并按 Enter = 替换当前
    await app.ev(`(() => { const input = document.querySelector('.search-panel .search-replace-input'); input.value = '丙'; return true })()`)
    await pressKey(app, 'Enter', 'Enter', 13)
    report.check('替换框 Enter：替换当前（第 1 个 甲 → 丙）', (await app.doc()) === '丙乙甲丙甲\n\n尾', JSON.stringify(await app.doc()))
    await pressKey(app, 'Escape', 'Escape', 27)
    report.check('Escape 关闭面板', await app.ev(`getComputedStyle(document.querySelector('.search-panel')).display`) === 'none', '')

    console.log('三、真实按键：F3 / Ctrl+G / Ctrl+Shift+G / Ctrl+H')
    await app.setDoc('甲乙甲丙甲\n\n尾')
    await app.select(0)
    await pressKey(app, 'KeyF', 'f', VK.f, CTRL)
    report.check('Ctrl+F 打开面板（兜底层仍在）', await app.ev(`getComputedStyle(document.querySelector('.search-panel')).display`) === 'grid', '')
    await app.ev(`(() => { const input = document.querySelector('.search-panel .search-input'); input.value = '甲'; input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(200)
    // 焦点在检索框里：F3 / Ctrl+G 由面板自己的 keydown 接（容器会拦 document 层）
    await pressKey(app, 'F3', 'F3', 114)
    report.check('面板内 F3：下一个（2/3）', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '2/3', '')
    await pressKey(app, 'F3', 'F3', 114, SHIFT)
    report.check('面板内 Shift+F3：上一个（1/3）', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '1/3', '')
    await pressKey(app, 'KeyG', 'g', VK.g, CTRL)
    report.check('面板内 Ctrl+G：下一个（2/3）', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '2/3', '')
    await pressKey(app, 'Escape', 'Escape', 27)
    // 面板关着、焦点在编辑器：document 层的 F3 / Ctrl+G 兜底
    await app.select(0)
    await pressKey(app, 'F3', 'F3', 114)
    await sleep(200)
    report.check('面板关着按 F3：打开并定位首个匹配（1/3）', await app.ev(`getComputedStyle(document.querySelector('.search-panel')).display`) === 'grid' && (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '1/3', '')
    await pressKey(app, 'KeyG', 'g', VK.g, CTRL)
    report.check('Ctrl+G：下一个（2/3）', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '2/3', '')
    await pressKey(app, 'KeyG', 'g', VK.g, CTRL | SHIFT)
    report.check('Ctrl+Shift+G：上一个（1/3）', (await app.ev(`document.querySelector('.search-panel .search-count').textContent`)) === '1/3', '')
    await app.select(0)
    await pressKey(app, 'KeyH', 'h', VK.h, CTRL)
    report.check('Ctrl+H：打开替换焦点（Windows 键位）', await app.ev(`(() => document.activeElement === document.querySelector('.search-panel .search-replace-input'))()`), String(await app.ev(`document.activeElement && document.activeElement.className`)))
    // 全部替换：Ctrl+Enter（面板内既有行为，别丢）
    await app.ev(`(() => { const input = document.querySelector('.search-panel .search-replace-input'); input.value = '丙'; return true })()`)
    await pressKey(app, 'KeyG', 'g', VK.g, CTRL | SHIFT)
    await pressKey(app, 'Enter', 'Enter', 13, CTRL)
    report.check('Ctrl+Enter：全部替换（甲 → 丙）', (await app.doc()) === '丙乙丙丙丙\n\n尾', JSON.stringify(await app.doc()))
    await pressKey(app, 'Escape', 'Escape', 27)

    console.log('四、编辑模块：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选')
    await app.setDoc('甲乙丙\n\n尾')
    await app.select(3) // 偏移 3 = 丙 之后
    await app.type('x')
    report.check('真实键入 x', (await app.doc()) === '甲乙丙x\n\n尾', JSON.stringify(await app.doc()))
    await clickItem(app, 'edit', '撤销')
    report.check('编辑→撤销：x 消失', (await app.doc()) === '甲乙丙\n\n尾', JSON.stringify(await app.doc()))
    await clickItem(app, 'edit', '重做')
    report.check('编辑→重做：x 回来', (await app.doc()) === '甲乙丙x\n\n尾', JSON.stringify(await app.doc()))
    await clickItem(app, 'edit', '全选')
    const selected = await app.ev(`document.getSelection().toString()`)
    report.check('编辑→全选：选区覆盖整篇', selected === '甲乙丙x\n\n尾', JSON.stringify(selected))
    // 剪切 + 粘贴走剪贴板一来一回
    await app.setDoc('甲乙丙\n\n尾')
    await app.select(0, 2)
    await clickItem(app, 'edit', '剪切')
    report.check('编辑→剪切：选区文字没了', (await app.doc()) === '丙\n\n尾', JSON.stringify(await app.doc()))
    report.check('编辑→剪切：剪贴板是「甲乙」', (await app.ev(`window.electronAPI.readClipboardText()`)) === '甲乙', String(await app.ev(`window.electronAPI.readClipboardText()`)))
    await app.select(0)
    await clickItem(app, 'edit', '粘贴')
    report.check('编辑→粘贴：文字回来', (await app.doc()) === '甲乙丙\n\n尾', JSON.stringify(await app.doc()))
    await app.select(0, 2)
    await clickItem(app, 'edit', '复制')
    report.check('编辑→复制：正文不动、剪贴板是「甲乙」', (await app.doc()) === '甲乙丙\n\n尾' && (await app.ev(`window.electronAPI.readClipboardText()`)) === '甲乙', JSON.stringify(await app.doc()))

    console.log('一（续）：文件模块的最近打开 / 清除最近记录')
    await app.setDoc('菜单齐全度验收\n')
    await app.ev(`window.electronAPI.appMenuAction('menu-save')`)
    await sleep(600)
    const recentLabels = await hoverItem(app, 'file', '最近打开')
    verdict = labelsInclude(JSON.parse(recentLabels), ['清除最近记录'])
    report.check('最近打开子菜单尾部有「清除最近记录」', verdict.ok, verdict.ok ? recentLabels : `缺 ${JSON.stringify(verdict.missing)}：${recentLabels}`)
    // 子菜单是悬停展开的：展开后点「清除最近记录」
    await openModule(app, 'file')
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-panel .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === '最近打开'); row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return true })()`)
    await sleep(350)
    await app.ev(`(() => { const row = [...document.querySelectorAll('.colamd-menu-flyout .colamd-menu-item')].find((item) => (item.querySelector('.colamd-menu-label')?.textContent ?? '').trim() === '清除最近记录'); if (row) row.click(); return !!row })()`)
    await sleep(400)
    report.check('清除最近记录后列表为空', (await app.ev(`window.electronAPI.getRecentFiles()`)).length === 0, JSON.stringify(await app.ev(`window.electronAPI.getRecentFiles()`)))

    console.log('六、Windows 系统字体枚举（字体设置下拉此前一直是空的）')
    const fonts = await app.ev(`window.electronAPI.listSystemFonts()`)
    report.check('listSystemFonts 在 Windows 非空（>50 族）', Array.isArray(fonts) && fonts.length > 50, `count=${Array.isArray(fonts) ? fonts.length : fonts}`)
    // 编辑器字体… 入口：模块菜单点开字体弹窗
    await clickItem(app, 'view', '编辑器字体…')
    await sleep(500)
    report.check('视图→编辑器字体…：字体弹窗打开', await app.ev(`!!document.querySelector('.font-modal')`), '')
    await app.ev(`(() => { const cancel = [...document.querySelectorAll('.font-modal .math-modal-btn')].find((button) => /取消|Cancel/.test(button.textContent)); if (cancel) cancel.click(); return true })()`)
    await sleep(200)

    console.log('二（续）：启动开关与主题入口不误伤')
    const restoreBefore = await app.ev(`window.electronAPI.getRestoreOnLaunch()`)
    await clickItem(app, 'file', '启动时打开上次文档')
    await sleep(300)
    const restoreAfter = await app.ev(`window.electronAPI.getRestoreOnLaunch()`)
    report.check('文件→启动时打开上次文档：开关翻转并持久化', restoreAfter === !restoreBefore, `${restoreBefore} → ${restoreAfter}`)
    await clickItem(app, 'file', '启动时打开上次文档')
    await sleep(300)
    report.check('再点一次：开关翻回去', (await app.ev(`window.electronAPI.getRestoreOnLaunch()`)) === restoreBefore, '')
  } finally {
    app.stop()
  }
}
report.summary()
