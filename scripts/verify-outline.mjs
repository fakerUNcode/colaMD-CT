// 大纲高亮跟随正文滚动验收（ColaMD CT，2026-11-24）。
//
// 起因：用户第三次报「大纲栏高亮仍然无法跟随正文进度」。前两次的修法在纯文字文档里是对的，
// 所以离屏验收一直是绿的；这次换成**带高块**的文档（表格、代码块、公式、图片——真实笔记的
// 样子）才复现：高亮差一到两节。
//
// 根因：旧实现拿 CodeMirror 的 lineBlockAt().top（估算的正文坐标）当标题位置。高度表只量过
// 滚到过的地方，没滚到的块按「一行文字」估，于是文档前半段只要有一块没量过，后面每条标题
// 的估算位置都偏。现在量标题在屏幕上的真实位置（coordsAtPos）。
//
// 断言：滚轮逐步滚、滚动条直接跳，每停一次，高亮的那一条必须等于「真实位置在阅读线之上的
// 最后一条标题」。真实位置用 coordsAtPos 从 DOM 上量，不经过被测的那段代码。
//
// 用法: npm run build && node scripts/verify-outline.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, reporter, sleep, VIEW } from './ct-harness.mjs'

const report = reporter('大纲高亮跟随')
const app = await launchApp('ct-outline')
const { ev, setDoc, select, renderer, center, click } = app

try {
  // 一张 60×40 的纯色 PNG（文档里要有图）
  const zlib = await import('node:zlib')
  const raw = Buffer.alloc((60 * 3 + 1) * 40, 120)
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(60, 0)
  ihdr.writeUInt32BE(40, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  mkdirSync(join(app.WORK, 'img'), { recursive: true })
  writeFileSync(join(app.WORK, 'img', 'a.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))

  // 16 节，每节：标题 + 两段正文 + 表格 + 代码块 + 公式块 + 图片——高矮悬殊，估算位置最容易偏
  const paragraphs = Array.from({ length: 2 }, (_, i) => `第${i + 1}段：这是一段用来撑高度的正文，重复几遍以便滚动。这是一段用来撑高度的正文，重复几遍以便滚动。`)
  const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |', '| 7 | 8 |'].join('\n')
  const code = ['```js', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '```'].join('\n')
  const sections = Array.from({ length: 16 }, (_, i) => `## 第${i + 1}节标题\n\n${paragraphs.join('\n\n')}\n\n${table}\n\n${code}\n\n$$\nx = 1\n$$\n\n![图](img/a.png)\n`)
  const text = sections.join('\n')
  await setDoc(text)
  await select(0)
  await sleep(500)

  // 打开文件面板 → 大纲页签
  if (await ev(`document.getElementById('file-panel').hidden`)) await ev(`document.getElementById('file-toggle-btn').click()`)
  await sleep(400)
  await ev(`document.getElementById('file-panel-outline').click()`)
  await sleep(500)
  report.check('大纲里有 16 条', (await ev(`document.querySelectorAll('#outline-list button').length`)) === 16)

  const active = () => ev(`(() => { const b = document.querySelector('#outline-list button.active'); return b ? [...document.querySelectorAll('#outline-list button')].indexOf(b) : -1 })()`)
  /**
   * 真实答案：阅读线之下**第一条量得到的标题**的前一条。
   * 标题位置用 coordsAtPos 从 DOM 上量（不经过被测代码）；量不到的标题都在渲染区之外，
   * 文档顺序就是屏幕顺序，所以夹在「阅读线上最后一条」和「阅读线下第一条」之间的量不到的标题
   * 也都在阅读线之上。阅读线与被测代码同一条：min(96, 可视高度 × 20%)。滚到底时高亮最后一条。
   * 一条标题都量不到时答案不可信（valid=false），这种停靠点不参与判定。
   */
  const truth = () => ev(`(() => {
    const view = ${VIEW}
    const scroller = view.scrollDOM
    const buttons = [...document.querySelectorAll('#outline-list button')]
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return JSON.stringify({ answer: buttons.length - 1, valid: true })
    const threshold = Math.min(96, scroller.clientHeight * 0.2)
    const scrollerTop = scroller.getBoundingClientRect().top + scroller.clientTop
    const titles = buttons.map((button) => button.textContent)
    let below = -1
    let measured = 0
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n)
      if (!line.text.startsWith('## ')) continue
      const index = titles.indexOf(line.text.slice(3))
      const rect = view.coordsAtPos(line.from)
      if (!rect) continue
      measured++
      if (rect.top - scrollerTop > threshold && below < 0) below = index
    }
    // 量到的标题全在阅读线之上：后面还有没有标题、在哪儿，无从知道
    const valid = measured > 0 && below >= 0
    return JSON.stringify({ answer: below - 1, valid })
  })()`)

  const editorPoint = await center(`document.querySelector('#editor .cm-scroller')`)
  const stops = []
  // 真实滚轮：一小步一小步往下滚
  for (let i = 0; i < 26; i++) {
    await renderer.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: editorPoint.x, y: editorPoint.y, deltaX: 0, deltaY: 360, button: 'none' })
    await sleep(450)
    const got = await active()
    const { answer, valid } = JSON.parse(await truth())
    stops.push({ how: `滚轮第 ${i + 1} 步`, got, answer, valid })
  }
  // 滚动条直接跳（拖滚动条、点大纲条目都是这种大跳）
  for (const fraction of [0.07, 0.21, 0.38, 0.52, 0.66, 0.81, 0.93]) {
    await ev(`(() => { const s = ${VIEW}.scrollDOM; s.scrollTop = (s.scrollHeight - s.clientHeight) * ${fraction}; return true })()`)
    await sleep(900)
    const got = await active()
    const { answer, valid } = JSON.parse(await truth())
    stops.push({ how: `跳到 ${Math.round(fraction * 100)}%`, got, answer, valid })
  }
  // 逐步往回滚
  for (let i = 0; i < 9; i++) {
    await renderer.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: editorPoint.x, y: editorPoint.y, deltaX: 0, deltaY: -420, button: 'none' })
    await sleep(450)
    const got = await active()
    const { answer, valid } = JSON.parse(await truth())
    stops.push({ how: `回滚第 ${i + 1} 步`, got, answer, valid })
  }
  let ok = 0
  let valid = 0
  for (const stop of stops) {
    // 答案只有在视口里量得到「阅读线之下」的标题时才可信
    if (!stop.valid) continue
    valid++
    if (stop.got === stop.answer) ok++
    else report.check(`${stop.how}：高亮第 ${stop.got + 1} 条，真实在第 ${stop.answer + 1} 条`, false)
  }
  report.check(`滚轮 26 步 + 跳转 7 处 + 回滚 9 步，高亮每一步都对得上（${ok}/${valid} 个有效停靠点）`, ok === valid && valid >= 25, `${ok}/${valid}`)

  // 点大纲条目跳过去，停稳后高亮就落在那一条上
  await ev(`document.querySelectorAll('#outline-list button')[9].click()`)
  await sleep(2600)
  report.check('点第 10 条跳过去：停稳后高亮在第 10 条', (await active()) === 9, `高亮在第 ${(await active()) + 1} 条`)

  // 改文档（在前面插一节）后大纲跟着更新，高亮仍对
  await ev(`${VIEW}.dispatch({ changes: { from: 0, to: 0, insert: '## 新插入的一节\\n\\n正文\\n\\n' } })`)
  await sleep(700)
  report.check('前面插入一节后大纲变成 17 条', (await ev(`document.querySelectorAll('#outline-list button').length`)) === 17)
  const point = await center(`document.querySelector('#editor .cm-scroller')`)
  await renderer.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 600, button: 'none' })
  await sleep(900)
  const afterEdit = await active()
  const { answer: answerAfterEdit, valid: validAfterEdit } = JSON.parse(await truth())
  report.check('改文档后再滚，高亮仍对得上', !validAfterEdit || afterEdit === answerAfterEdit, `高亮第 ${afterEdit + 1} 条，真实在第 ${answerAfterEdit + 1} 条`)

  const errors = JSON.parse(await ev(`JSON.stringify(window.__verifyErrors ?? [])`))
  report.check('整轮运行没有渲染进程报错', errors.length === 0, JSON.stringify(errors))
} finally {
  app.stop()
}
report.summary()
