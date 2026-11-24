declare module 'katex/dist/katex.min.css?inline' {
  const css: string
  export default css
}

interface Window {
  electronAPI: import('../preload/index').ElectronAPI
  /** 主进程在 printToPDF 前后叫它，把光标与当前行的源码从纸上拿掉。 */
  __colamdPrintExport?: { enter: () => void; exit: () => void }
  __colamdExportDocumentHTML?: () => string
  /** 图片右键菜单的验收入口（editor.ts 装）：接走菜单请求、直接执行菜单动作。 */
  __colamdImageMenu?: {
    intercept: (sink: ((request: import('../../shared/image-syntax').ImageMenuRequest) => void) | null) => void
    run: (action: string, from: number, to: number) => boolean
  }
}
