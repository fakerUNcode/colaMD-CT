// 图片右键菜单验收（ColaMD CT，2026-11-24）。
//
// 起因：用户报「图片无右键菜单，不能进行大小缩放等功能」。
//
// 原生菜单在离屏窗口里点不到，所以分两头验：
//   渲染端（这里）  右键（真实鼠标）时发出去的菜单请求对不对——哪张图、哪个区间、哪些项可用；
//                    菜单里改文档的三个动作（缩小 / 放大 / 恢复原始大小）直接执行，断言源码怎么变、
//                    画面怎么变、表格有没有被弄退回源码、撤销能不能回去。经 window.__colamdImageMenu
//                    这个验收入口（editor.ts 装）接走请求、执行动作。
//   `<img>` 标签     缩放过的图片是 `<img … width>` 写法：要按图片渲染、相对路径按文档地址解析。
//   主进程（手测）  复制图片 / 复制地址 / 打开 / 在文件夹中显示 / 另存为：见 README_CT 的手测清单。
//
// 用法: npm run build && node scripts/verify-image-menu.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, reporter, sleep, CTRL, VIEW } from './ct-harness.mjs'

const report = reporter('图片右键菜单')
const app = await launchApp('ct-image-menu')
const { ev, doc, setDoc, select, click, center, press } = app

// 一张 200×120 的纯色 PNG：缩放要有真实尺寸可量
const zlib = await import('node:zlib')
const pngOf = (w, h, [r, g, b]) => {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(kind), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
mkdirSync(join(app.WORK, 'img'), { recursive: true })
writeFileSync(join(app.WORK, 'img', 'big.png'), pngOf(200, 120, [60, 120, 200]))

const docLine = async (n) => (await doc()).split('\n')[n]
/** 正文与表格里的真图片（CodeMirror 自己的 <img> 占位不算）。 */
const images = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#editor .cm-md-image img, #editor .cm-md-table-widget img')].map((img) => ({ src: (img.getAttribute('src') ?? '').replace(/^.*\\//, ''), widthAttr: img.getAttribute('width'), alt: img.alt, w: Math.round(img.getBoundingClientRect().width), natural: img.naturalWidth })))`))
const widths = async () => (await images()).map((image) => image.w).join(' ')
const sourceOf = (index) => ev(`(() => { const el = document.querySelectorAll('#editor .cm-md-image')[${index}]; return JSON.stringify({ from: Number(el.dataset.sourceFrom), to: Number(el.dataset.sourceTo) }) })()`)
const lastRequest = () => ev(`JSON.stringify(window.__imgMenu[window.__imgMenu.length - 1] ?? null)`)
const rightClick = async (selectorExpr) => {
  const point = await center(selectorExpr)
  await click(point.x, point.y, 'right')
  await sleep(250)
  return JSON.parse(await lastRequest())
}
const run = (action, target) => ev(`window.__colamdImageMenu.run(${JSON.stringify(action)}, ${target.from}, ${target.to})`)
const pick = (request, keys) => keys.map((key) => `${key}=${request[key]}`).join(' ')

try {
  const text = ['![图](img/big.png)', '', '<img src="img/big.png" alt="标签图">', '', '前 <img src="img/big.png" alt="缩过" width="40"> 后', '', '| 图 |', '| --- |', '| ![格](img/big.png) |', '', '尾行', ''].join('\n')
  await setDoc(text)
  await select(text.length - 1)
  await sleep(900)
  await ev(`(() => { window.__imgMenu = []; window.__colamdImageMenu.intercept((request) => window.__imgMenu.push(request)); window.__ctxSeen = 0; document.addEventListener('contextmenu', () => { window.__ctxSeen++ }, false); return true })()`)

  console.log('一、`<img>` 标签按图片渲染')
  report.check('正文三张图 + 表格里一张图，都按文档地址解析、读出原始尺寸 200', (await images()).map((image) => `${image.src}:${image.natural}`).join(' ') === 'big.png:200 big.png:200 big.png:200 big.png:200', JSON.stringify(await images()))
  report.check('带 width="40" 的图片显示宽度是 40', (await widths()) === '200 200 40 200', (await widths()))
  const absolute = await ev(`document.querySelector('#editor .cm-md-image-html img').getAttribute('src')`)
  report.check('`<img>` 的相对路径按文档所在目录解析成绝对地址', /^file:\/\/.*\/img\/big\.png$/.test(absolute), absolute)

  console.log('二、Markdown 写法的图片')
  let target = JSON.parse(await sourceOf(0))
  let request = await rightClick(`document.querySelectorAll('#editor .cm-md-image')[0].querySelector('img')`)
  report.check('右键：菜单请求（地址、可用项）', pick(request, ['rawSrc', 'local', 'canZoomIn', 'canZoomOut', 'canActualSize', 'hasInfoCard']) === 'rawSrc=img/big.png local=true canZoomIn=false canZoomOut=true canActualSize=false hasInfoCard=true', pick(request, ['rawSrc', 'local', 'canZoomIn', 'canZoomOut', 'canActualSize', 'hasInfoCard']))
  report.check('右键被图片菜单接走（事件不再冒泡到 document）', String(await ev(`window.__ctxSeen`)) === '0')
  await run('zoomOut', target)
  await sleep(350)
  report.check('缩小：源码改写成 <img width=160>', (await docLine(0)) === '<img src="img/big.png" alt="图" width="160">', JSON.stringify(await docLine(0)))
  report.check('缩小后显示宽度 160', (await widths()) === '160 200 40 200', await widths())

  target = JSON.parse(await sourceOf(0))
  request = await rightClick(`document.querySelectorAll('#editor .cm-md-image')[0].querySelector('img')`)
  report.check('缩小后再右键：可放大、可恢复', pick(request, ['canZoomIn', 'canZoomOut', 'canActualSize']) === 'canZoomIn=true canZoomOut=true canActualSize=true', pick(request, ['canZoomIn', 'canZoomOut', 'canActualSize']))
  await run('zoomIn', target)
  await sleep(350)
  report.check('放大：宽度回到 200', (await docLine(0)) === '<img src="img/big.png" alt="图" width="200">', JSON.stringify(await docLine(0)))
  await run('actualSize', target)
  await sleep(350)
  report.check('恢复原始大小：回到 Markdown 写法', (await docLine(0)) === '![图](img/big.png)', JSON.stringify(await docLine(0)))
  report.check('恢复后图片照常渲染、宽度 200', (await widths()) === '200 200 40 200', await widths())

  console.log('三、`<img>` 标签写法的图片')
  target = JSON.parse(await sourceOf(1))
  request = await rightClick(`document.querySelectorAll('#editor .cm-md-image')[1].querySelector('img')`)
  report.check('右键 `<img>` 图片：请求与 Markdown 写法一致', pick(request, ['rawSrc', 'local', 'hasInfoCard', 'canZoomOut']) === 'rawSrc=img/big.png local=true hasInfoCard=true canZoomOut=true', pick(request, ['rawSrc', 'local', 'hasInfoCard', 'canZoomOut']))
  await run('zoomOut', target)
  await sleep(350)
  report.check('缩小：在标签上改 width', (await docLine(2)) === '<img src="img/big.png" alt="标签图" width="160">', JSON.stringify(await docLine(2)))

  target = JSON.parse(await sourceOf(2))
  request = await rightClick(`document.querySelectorAll('#editor .cm-md-image')[2].querySelector('img')`)
  report.check('已是 40px：不可再缩小、可恢复', pick(request, ['canZoomIn', 'canZoomOut', 'canActualSize']) === 'canZoomIn=true canZoomOut=false canActualSize=true', pick(request, ['canZoomIn', 'canZoomOut', 'canActualSize']))
  await run('actualSize', target)
  await sleep(350)
  report.check('恢复：回到 Markdown 写法，前后的文字不变', (await docLine(4)) === '前 ![缩过](img/big.png) 后', JSON.stringify(await docLine(4)))

  console.log('四、表格格子里的图片')
  request = await rightClick(`document.querySelector('.cm-md-table-widget td img')`)
  report.check('右键格子里的图片：区间正好是这段图片源码', (await doc()).slice(request.from, request.to) === '![格](img/big.png)', (await doc()).slice(request.from, request.to))
  report.check('格子里的图片没有「图片信息」这一项（它点不出信息卡）', request.hasInfoCard === false)
  await run('zoomOut', request)
  await sleep(400)
  report.check('缩小：格子里的源码改写', (await docLine(8)) === '| <img src="img/big.png" alt="格" width="160"> |', JSON.stringify(await docLine(8)))
  const tableState = JSON.parse(await ev(`JSON.stringify({ tables: document.querySelectorAll('.cm-md-table-widget').length, w: Math.round(document.querySelector('.cm-md-table-widget td img').getBoundingClientRect().width) })`))
  report.check('表格保持渲染（没有退回源码），格内图片宽 160', tableState.tables === 1 && tableState.w === 160, JSON.stringify(tableState))
  await press('KeyZ', 'z', 90, CTRL)
  await sleep(350)
  report.check('撤销：格子里的图片回到原样', (await docLine(8)) === '| ![格](img/big.png) |', JSON.stringify(await docLine(8)))

  console.log('五、源码可改、信息卡')
  target = JSON.parse(await sourceOf(1))
  await ev(`${VIEW}.dispatch({ selection: { anchor: ${target.from} } })`)
  await sleep(300)
  const revealed = await ev(`document.querySelectorAll('#editor .cm-content > .cm-line')[2].textContent`)
  report.check('光标在 `<img>` 源码开头：图片退回源码可改', revealed === '<img src="img/big.png" alt="标签图" width="160">', revealed)
  await select((await doc()).length)
  await sleep(300)
  const point = await center(`document.querySelectorAll('#editor .cm-md-image')[0].querySelector('img')`)
  await click(point.x, point.y)
  await sleep(350)
  const card = JSON.parse(await ev(`JSON.stringify({ hint: document.querySelector('.colamd-image-info .colamd-image-info-hint')?.textContent ?? '', rows: [...document.querySelectorAll('.colamd-image-info-row')].map((row) => [...row.children].map((el) => el.textContent).join(':')) })`))
  report.check('点图片出信息卡，卡上有「右键图片可缩放」的提示', card.hint === '右键图片可缩放', JSON.stringify(card))
  report.check('信息卡：名称 / Alt / 地址 / 尺寸 / 显示宽度自动 / 源码路径', JSON.stringify(card.rows.slice(0, 5)) === JSON.stringify(['名称:big.png', 'Alt:图', `地址:${absolute}`, '尺寸:200 × 120 px', '显示宽度:自动（按图片自身大小）']) && card.rows.includes('源码路径:img/big.png'), JSON.stringify(card.rows))

  const errors = JSON.parse(await ev(`JSON.stringify(window.__verifyErrors ?? [])`))
  report.check('整轮运行没有渲染进程报错', errors.length === 0, JSON.stringify(errors))
} finally {
  app.stop()
}
report.summary()
