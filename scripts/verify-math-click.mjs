// 点公式落光标验收（ColaMD CT，2026-11-24）。
//
// 起因：`verify:table-ops` 里「第一次点行内公式：光标落进区间（右侧）」时过时不过。抓现场：
// mousedown 的默认行为先把浏览器原生光标放到公式某一侧，CodeMirror 一同步选区，公式当场退回
// 源码；按下位置的元素从 DOM 里消失，浏览器不再派发 click（按下和松开的不是同一个节点），
// 「按横向比例落位」的逻辑根本没机会跑，光标停在区间起点。v2.7.22 的原始构建上 48 轮撞不到，
// 之后的构建 96 轮撞到 13 轮。现在在 mousedown 的捕获阶段就拦下、当场放好光标。
//
// 断言：点公式右侧（80%）光标落在区间右半边，点左侧（20%）落在左半边，各 24 轮一轮都不许偏。
//
// 用法: npm run build && node scripts/verify-math-click.mjs
import { launchApp, reporter, sleep, VIEW } from './ct-harness.mjs'

const report = reporter('点公式落光标')
const app = await launchApp('ct-math-click')
const { ev, renderer, setDoc, select } = app
try {
  // `文字 $a+b+c$ 收尾`：公式区间是 3..10
  const rounds = async (fraction, name, low, high) => {
    const bad = []
    for (let i = 0; i < 24; i++) {
      await setDoc('文字 $a+b+c$ 收尾\n\n尾行')
      await select(13)
      const rect = JSON.parse(await ev(`(() => { const r = document.querySelector('.cm-md-math-inline').getBoundingClientRect(); return JSON.stringify({ left: r.left, width: r.width, y: r.top + r.height / 2 }) })()`))
      const x = rect.left + rect.width * fraction
      await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: rect.y, button: 'left', clickCount: 1 })
      await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: rect.y, button: 'left', clickCount: 1 })
      await sleep(350)
      const head = await app.head()
      const revealed = (await ev(`!!document.querySelector('.cm-md-math-inline')`)) === false
      if (!(head >= low && head <= high && revealed)) bad.push(`第 ${i + 1} 轮 head=${head}${revealed ? '' : '（公式没有退回源码）'}`)
    }
    report.check(`${name} 24 轮：每轮光标都落在区间内对应的一半`, bad.length === 0, bad.join('；'))
  }
  await rounds(0.8, '点公式右侧（80%）', 8, 10)
  await rounds(0.2, '点公式左侧（20%）', 3, 6)

  // 光标移走后公式重新渲染；块公式点一下也把光标放进区间
  await ev(`${VIEW}.dispatch({ selection: { anchor: 13 } })`)
  await sleep(350)
  report.check('光标移出后公式重新渲染', (await ev(`!!document.querySelector('.cm-md-math-inline')`)) === true)
  await setDoc('前文\n\n$$\nx = 1\n$$\n\n尾行')
  await select(2)
  await sleep(400)
  const block = JSON.parse(await ev(`(() => { const r = document.querySelector('.cm-md-math-block').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  await renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: block.x, y: block.y, button: 'left', clickCount: 1 })
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: block.x, y: block.y, button: 'left', clickCount: 1 })
  await sleep(350)
  const blockHead = await app.head()
  const blockSource = await ev(`document.querySelector('#editor .cm-content').textContent.includes('x = 1') && !document.querySelector('.cm-md-math-block')`)
  report.check('点块公式：光标落进区间、源码显形', blockHead >= 5 && blockHead <= 13 && blockSource === true, `head=${blockHead} 源码显形=${blockSource}`)

  const errors = JSON.parse(await ev(`JSON.stringify(window.__verifyErrors ?? [])`))
  report.check('整轮运行没有渲染进程报错', errors.length === 0, JSON.stringify(errors))
} finally {
  app.stop()
}
report.summary()
