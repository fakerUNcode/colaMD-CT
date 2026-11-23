// 检索高亮的装饰。
//
// 单独成一个文件是为了打断一个循环依赖：装饰要装进编辑器扩展（core.ts），而检索面板
// （search-panel.ts）要用同一个 effect 去改它。两边都从这里取，谁也不用 import 谁。
//
// 关键一条：装饰必须真的装进编辑器。这里定义了 StateField 但没人 `provide` 它，
// 面板派发的 effect 就没有任何 StateField 接住，高亮会静默地什么也不做
// （面板自己以为画上了）。core.ts 的扩展表里有它。

import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'

/** 换掉当前的高亮集合。传 `Decoration.none` 就是清空。 */
export const setSearchHighlight = StateEffect.define<DecorationSet>()

export const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlight)) return effect.value
    }
    return value.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

// ─── ColaMD CT：匹配的位置本身也要让渲染层知道 ─────────────────────────────
//
// 上面那套高亮是「标记装饰」，只对页面上真实存在的文字有用。表格、公式、图这些块
// 是被整个换成 widget 画出来的——缓冲区里那段文字在页面上并不存在，标记落在上面
// 等于没画（用户报的「查找时表格里的文字不高亮，只跳到位置」）。所以匹配的位置
// 单独存一份：表格 widget 据此在单元格里自己画高亮；公式/图/HTML 块据此临时
// 退回源码，让标记落在看得见的文字上。

export interface SearchMatch {
  from: number
  to: number
}

export interface SearchState {
  matches: SearchMatch[]
  /** 当前匹配项在 matches 里的下标。 */
  current: number
}

/** 换掉匹配集合。传 null = 没有在查找（面板关了或输入为空）。 */
export const setSearchState = StateEffect.define<SearchState | null>()

export const searchStateField = StateField.define<SearchState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchState)) return effect.value
    }
    // 文档改了（替换当前项、或用户直接编辑）：位置跟着映射，免得替换到错的地方
    if (!value || !tr.docChanged) return value
    return {
      matches: value.matches.map((match) => ({ from: tr.changes.mapPos(match.from, -1), to: tr.changes.mapPos(match.to, 1) })),
      current: value.current,
    }
  },
})
