# ColaMD CT

**ColaMD CT** 是 [ColaMD](https://github.com/marswaveai/ColaMD)（MIT，marswave.ai 出品）的社区增强版：UI 与官方版完全一致，在其「文本优先」架构上补齐了三块 Typora 级能力。 

- 图片工作流：粘贴 / 拖拽 / 命令插入，图床上传（PicGo · GitHub · SM.MS · 自定义 HTTP）或复制到文档目录，失败自动降级本地副本
- 表格编辑：右键菜单加删行列 / 对齐 / 移动 / 删表，**渲染态单元格就地编辑**，Tab 导航，末格 Tab 加行，表头拖拽调列宽
- 快捷键全家桶：Typora 默认键位全覆盖 + 任意改绑（偏好设置 → 快捷键），菜单与键盘同步生效
- Windows 标题栏菜单主题化：汉堡按钮弹出**跟主题的自绘菜单**（偏好设置独立成行），快捷键仍由原生菜单注册
- 「设为默认应用」三平台可用：macOS LaunchServices / Windows 注册表 + 系统设置页 / Linux xdg-mime

> 基于 ColaMD v2.7.12 修改，遵循 MIT 许可证；原版权与许可声明见 [LICENSE](LICENSE)。

---

## 与官方版的关系

| | 官方 ColaMD | ColaMD CT |
|---|---|---|
| 应用标识 | `ai.marswave.colamd` | `ai.marswave.colamdct` |
| 安装名 | ColaMD | ColaMD CT |
| 共存 | — | **并行安装互不影响** |
| 应用内更新 | GitHub Releases | **已禁用**（防止被官方包覆盖升级，更新请重新构建） |

其余全部继承官方版：12 套主题、导出（PDF/HTML/Word/图片/幻灯片）、标签页、大纲、文件面板、源码模式、实时同步磁盘、Mermaid、KaTeX、脚注……

## 构建

```bash
npm install
npm run build        # 类型检查 + electron-vite 打包（dist/）
npm run dist:win     # Windows：release/ColaMD-CT-Setup-<v>.exe + 便携 zip
```

**Linux（在 WSL Ubuntu 里构建，Windows 宿主不支持 AppImage/deb）**：

```bash
wsl -d Ubuntu-24.04 -- bash build-tools/wsl-build.sh all
# 产物回拷到 release/：ColaMD-CT-<v>-x86_64.AppImage + ColaMD-CT-<v>-amd64.deb
```

**macOS**：

- **zip（本机即出）**：`wsl-build.sh` 的 `mac-dist` 阶段构建**不签名** zip（含完整 .app 与 framework 符号链接），解压后右键 → 打开过一次 Gatekeeper 即可用。
- **dmg / pkg（需要真 macOS）**：这是二进制层面的硬限制，交叉构建走不通——实测证据：dmg 底层的 dmgbuild 工具链绑定的 Python/PyObjC 是 `*-darwin.so`（Mach-O），pkg 底层的 `pkgbuild`/`productbuild` 是 macOS 专属。两条正途：
  1. **GitHub Actions（推荐，免费）**：仓库已带 `.github/workflows/release.yml`，推 `v*` 标签即自动构建三平台并发布 GitHub Release：macOS 的 **dmg + pkg + zip，arm64 与 x64 各一份**（未签名），连同 Windows 安装器 / 便携 zip 与 Linux AppImage / deb 一起出现在 Releases 页；手动 Run workflow 则只构建不发版，产物在 Artifacts 里核对。
     ```bash
     git remote add origin git@github.com:<你>/colamd-ct.git
     git push -u origin main
     ```
  2. **任意一台 Mac**：`bash build-tools/mac-build.sh` 一键产出同样的 dmg + pkg + zip。
- 需要签名/公证：把证书配进 Secrets 并按 electron-builder 文档设置（工作流里已留 `CSC_IDENTITY_AUTO_DISCOVERY` 开关位）。

> 网络差的环境：脚本全部走 npmmirror 镜像（electron / electron-builder-binaries / npm registry）；electron-builder 自带下载器对大文件常被 CDN 掐断，`wsl-build.sh` 用 curl 断点续传 + `electronDist` 绕过。

## 设为默认应用（三平台）

- **macOS**：LaunchServices 直接接管 .md/.markdown/.mdown/.mkd/.txt
- **Windows**：写 HKCU 注册表（ProgId + Capabilities + RegisteredApplications），随后打开系统「默认应用」设置页——Win8 起不允许应用静默改默认，需最后点选一次（VSCode 同款做法）
- **Linux**：`xdg-mime default`（deb/AppImage 安装的 desktop 文件）

## Windows 应用菜单

标题栏汉堡按钮弹出**主题化自绘菜单**（替代原生灰菜单）：偏好设置独立成行置顶，按「文档 / 视图 / 导出 / 系统」分区，主题与语言有二级面板并带当前项勾选；快捷键仍由后台原生菜单注册，Ctrl+S 等照常工作。

## 图片工作流

### 插入方式

- **粘贴**：截图（Ctrl+V）、复制文件、复制网页图片（`<img src="http…">` 直接按引用插入）
- **拖拽**：图片文件拖进正文 = 插入到落点；其他文件拖入仍是「打开文档」
- **命令**：`Ctrl+Shift+I` 或 格式 → 插入图片…（可多选）

### 插入行为（偏好设置 → 图片）

| 行为 | 说明 |
|---|---|
| 每次询问（默认） | 弹窗三选一 + 「记住选择」 |
| 上传到图床 | 按所选图床服务上传，插入 URL；**失败自动降级为本地副本**（不丢图） |
| 复制到文档目录 | 存入 `<文档目录>/<复制目录>/`（默认 `assets/`），插入**相对路径**（遵循官方版便携路径纪律：文件里写相对路径，保存时不动你的字节） |
| 保留原路径 | 仅拖拽本地文件时可选；剪贴板截图无「原路径」，等同复制 |

- 文件名模板：`{name}` 原名 · `{hash}` 内容哈希前 8 位 · `{date}` yyyyMMdd，默认 `{name}-{hash}`，重名自动 `-2`、`-3` 递增
- 未命名文档里选「复制」会落到 `~/.colamd/images/yyyyMM/` 并写绝对路径；另存文档后可再拖一次换成相对路径

### 图床配置

**PicGo（推荐）**：装 [PicGo 桌面版](https://github.com/Molunerfinn/PicGo) 并开启 Server（默认 `http://127.0.0.1:36677/upload`）。CT 只调它的本机 API，图床账号全在 PicGo 里管理。

**GitHub 仓库图床**：建一个（建议公开）仓库，填 Token（需要 `repo` 权限）、Owner、Repo、分支、仓库内目录。可选 jsDelivr CDN 直链（仓库须公开，速度快）。文件按 `日期/哈希.扩展名` 存放，天然不重名。

**SM.MS**：[sm.ms](https://sm.ms) 注册后取 API Token。

**自定义 HTTP**：任何接受 multipart 的上传接口——配置上传地址、文件字段名（默认 `image`）、额外请求头（JSON，如鉴权）、响应取值路径（如 `data.url`；留空自动猜常见形状；纯文本 URL 响应也认）。

> Token 只存在本机 `userData/settings.json`，上传请求全部由主进程发出（渲染端 CSP 管不着也看不见凭据）。

## 表格编辑

**表格在编辑时保持渲染（2.7.14 起）**：点击单元格就地编辑（格子描一圈主题色边框），Tab/Enter 换格、末格自动加行、Shift+Enter 写 `<br>`，全程不退源码；改动在离开格子时一次性写回源码（可撤销）。要直接改源码，去源码模式（Ctrl+/）。

- **右键表格**：在上方/下方插入行、左/右侧插入列，删除行/列，行/列上移下移，左/中/右对齐，删除表格——操作后表格**保持渲染**，光标落在表外
- 所有操作 = 一次可撤销的文本事务；序列化时竖线按列宽对齐（Typora 同款排版），`\|` 转义保留
- **列宽拖拽**：悬停表头右缘出现把手，直接拖。宽度按「文档路径 + 表头内容」存 sidecar（`userData/table-widths.json`），**md 文件一个字节都不多**
- **插入表格**：`Ctrl+Shift+T` 或 格式 → 插入表格…，Typora 式行×列网格选择器
- 表格后请留一个空行（GFM 惯例）：语法节点紧贴正文行时会把正文吞进表格范围，此时 CT 会拒绝结构化操作以保护正文

## 图片信息卡

点击渲染出来的图片 → 浮出信息卡：**名称 / Alt / 地址（绝对路径 + 源码里的相对路径）/ 像素尺寸 / 文件大小**（本地文件）。「编辑地址」把光标放进源码那一行就地改。Esc / 点击卡外 / 滚动 关闭。

## 文件拖放与粘贴

| 动作 | 结果 |
| --- | --- |
| 拖**图片**进正文 | 走图片管线（询问/上传/复制/引用） |
| 拖**任意其他文件**（.md、.pdf…）进正文 | 插入 `[文件名](相对或绝对路径)` 链接，**不粘内容、不换文档** |
| **Ctrl+V** 粘贴复制的文件 | 同上，插入文件链接 |
| 拖 .md 到**正文以外**（文件面板、标题栏等） | 照旧「打开文档」 |

## 快捷键（默认值，全部可在偏好设置改绑）

| 命令                | Windows/Linux                                    | macOS                 |
| ----------------- | ------------------------------------------------ | --------------------- |
| 标题 1–6            | `Ctrl+1` … `Ctrl+6`                              | `Cmd+1` … `Cmd+6`     |
| 正文                | `Ctrl+Shift+0`                                   | `Cmd+Shift+0`         |
| 提升 / 降低标题级别       | `Alt+=` / `Alt+-`                                | `⌥=` / `⌥-`           |
| 加粗 / 斜体 / 行内代码    | `Ctrl+B` / `Ctrl+I` / `Ctrl+E`                   | Cmd+B / Cmd+I / Cmd+E |
| 下划线（`<u>`）        | Ctrl+U                                           | Cmd+U                 |
| 删除线 / 高亮          | `Ctrl+Shift+X` / `Ctrl+Shift+H`                  | `⇧⌘X` / `⇧⌘H`         |
| 链接（网址取自剪贴板）       | `Ctrl+K`                                         | `Cmd+K`               |
| 无序 / 有序 / 任务列表    | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` | ⇧⌘8 / ⇧⌘7 / ⇧⌘9       |
| 引用 / 代码块 / 公式块    | `Ctrl+Shift+Q` / `Ctrl+Shift+K` / `Ctrl+Shift+M` | `⇧⌘Q` / `⇧⌘K` / `⇧⌘M` |
| 插入图片 / 插入表格 / 水平线 | Ctrl+Shift+I / Ctrl+Shift+T / Ctrl+Shift+-       | 同左（Cmd）               |
| 偏好设置              | `Ctrl+,`                                         | Cmd+,                 |

改绑：**文件 → 偏好设置… → 快捷键**。点击按键条 → 按新组合；`Backspace` 解绑；`Esc` 取消；↺ 恢复单条默认；「全部恢复默认」一键还原。冲突键位红色高亮。保存后菜单 accelerator 与键盘立即同步（含其它窗口）。

> 与官方版既有绑定冲突处，官方版优先（CT 原则：原手感不变）：`Ctrl+T` 新标签页、`Ctrl+0` 字号重置、`Ctrl+Plus/-` 字号缩放均保持官方含义，Typora 的对应功能走上表键位。

## 新增 / 修改的源码一览

```
src/shared/commands.ts          命令注册表（菜单/键盘/偏好设置共用）
src/shared/settings-types.ts    设置类型
src/main/settings.ts            userData/settings.json 读写
src/main/image-upload.ts        图床上传 + 本地副本（主进程，零新依赖）
src/renderer/editor/image-input.ts   粘贴/拖拽接管、占位符两阶段插入、文件链接
src/renderer/editor/image-info.ts    图片信息卡
src/renderer/editor/table-ops.ts     表格模型、行列操作、渲染态单元格编辑、列宽拖拽
src/renderer/editor/keymap-config.ts 快捷键 DOM 匹配（热更新）
src/renderer/preferences.ts     偏好设置弹窗（按功能分区）
```

接线改动：`core.ts`（paste/drop + tableInput 扩展）、`editor.ts`（单元格点击编辑、表格右键、图片信息卡）、`format-commands.ts`（全家桶命令）、`live-preview.ts`（TableWidget 列宽 + 待聚焦单元格）、`main.ts`（外壳接线）、`main/index.ts`（IPC + 菜单 + 禁用更新）、`preload/index.ts`（桥接）、`electron-builder.yml`、四个 `tsconfig.*.json`（纳入 `src/shared`）。

另修了两个上游脚本在 Windows 上的问题：`verify-workdir.mjs` 的路径分隔符比较、各 verify 脚本的 `spawn('npx')`（Windows 上 Node 不再允许直接 spawn .cmd，改为直接调 `node_modules/electron/cli.js`）。

## 手工验收清单

1. 截图 Ctrl+V → 询问弹窗 → 复制到文档目录 → `assets/` 出现文件，源码里是相对路径，图片正常显示，保存后字节与所见一致
2. PicGo 开 Server → 上传到图床 → 占位符被替换为图床 URL；关掉 PicGo 再传 → 降级本地副本 + 底部提示
3. 拖一张图进正文中间 → 插在落点；拖一个 .md / .pdf 进正文 → 插入 `[文件名](路径)` 链接而非粘内容；拖 .md 到文件面板 → 仍走打开文档
4. 点击渲染出的图片 → 信息卡（名称/地址/尺寸/大小）→「编辑地址」进源码
5. `Ctrl+Shift+T` → 网格选 3×3 → 空表落位
6. **渲染态编辑**：点击任意单元格 → 就地打字 → Tab/Enter 换格 → 表格全程保持渲染，源码正确更新
7. 右键表格全套操作 → 表格保持渲染；对齐后分隔行出现 `:---:`；`Ctrl+Z` 一步撤销
8. 悬停表头拖列宽 → 重启应用重开文档 → 列宽还在，md 文件 diff 为空
9. `Ctrl+1..6` 设标题、`Ctrl+Shift+0` 回正文；偏好设置改绑（先按 Alt 再按数字可识别，如 Alt+1）→ 菜单与键盘同时生效
10. 确认帮助菜单无「检查更新」、启动 8 秒后无更新请求（官方更新源已隔离）
11. 回归：`verify:markdown`（93/93）、`verify:source-mode`（198/198）、`verify:list`（43/43）、`verify:themes`（26/26）、`verify:table-ops`（22/22）
