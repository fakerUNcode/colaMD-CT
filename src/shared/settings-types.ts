// ColaMD CT：设置的类型定义。
//
// 放在 shared：主进程（settings.ts 的存取）和渲染端（偏好设置弹窗的表单）
// 都要认这份结构，谁也不许各自漂移。

export type ImageInsertBehavior = 'ask' | 'upload' | 'copy' | 'reference'
export type ImageUploadProvider = 'picgo' | 'github' | 'smms' | 'custom'

export interface ImageSettings {
  /** 粘贴/拖入图片时的处理方式。ask = 每次询问。 */
  insertBehavior: ImageInsertBehavior
  /** ask 弹窗里勾了「记住选择」之后不再询问。 */
  rememberChoice: boolean
  uploadProvider: ImageUploadProvider
  /** 「复制到文档目录」用的子目录，相对文档所在目录。 */
  copyDir: string
  /** 落盘文件名模板：{name} 原名、{hash} 内容哈希前 8 位、{date} yyyyMMdd。 */
  namePattern: string
  picgo: { url: string }
  github: {
    token: string
    owner: string
    repo: string
    branch: string
    /** 仓库内的存放目录。 */
    path: string
    /** 走 jsDelivr CDN（更快，但仓库须公开）。 */
    useJsDelivr: boolean
  }
  smms: { token: string }
  custom: {
    url: string
    /** multipart 的文件字段名。 */
    fieldName: string
    headers: Record<string, string>
    /** 响应里 URL 的取值路径，如 `data.url`。 */
    responsePath: string
  }
}

/** Markdown 方言：默认对中文用户友好（宽松强调），可在偏好设置里关掉回到严格 CommonMark。 */
export interface MarkdownDialectSettings {
  /**
   * 宽松强调：CommonMark 的成对判定把全角标点（。（），：等）当标点，
   * `**加粗**。`、`（**粗**）` 这类写法会整个失效（2026-11-22 用户报的
   * 「加粗有时候无法正常显示」）。开启后渲染层补画被严格规则拒掉的
   * 加粗、斜体、删除线标记——只放宽标点侧判定，空格侧仍从严
   * （`** 粗**` 依旧不渲染）。
   */
  looseEmphasis: boolean
  /** 行内公式 `$x$`：关闭后 `$` 就是普通字符（块级 `$$` 不受影响）。 */
  inlineMath: boolean
  /** 高亮 `==文字==`（本站自有语法）。 */
  highlight: boolean
}

export interface TableSettings {
  /** 记住表格列宽（sidecar 存档）。关闭后列宽不再随文档恢复。 */
  rememberWidths: boolean
}

export interface AppSettings {
  image: ImageSettings
  markdown: MarkdownDialectSettings
  table: TableSettings
  /** 命令 id → accelerator 覆盖（空串 = 解绑）。 */
  keybindings: Record<string, string>
}

/** 局部更新的形状：只到两层深（section → 字段）。 */
export type SettingsPatch = {
  [K in keyof AppSettings]?: Partial<AppSettings[K]>
}
