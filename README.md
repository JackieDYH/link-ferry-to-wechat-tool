# 小红书/今日头条文章 → 微信公众号 上传工具（独立版）

一个本地小工具：粘贴**小红书笔记**或**今日头条文章**链接，自动抓取内容，上传到你的微信公众号**草稿箱**（支持贴图/文章两种形式），带网页操作界面和实时进度。

界面为 **Vue3 + Vite** 构建的响应式单页应用，后端为 **Express** 服务（业务逻辑在 `xhs-core.mjs`，前后端分离，通过 `/api/*` 接口通信）。

不需要 OpenClaw、不需要联网服务，纯本地运行（仅需 Node.js，首次构建前端需联网）。

---

## 一、环境要求

- Windows 系统
- 已安装 Node.js（版本 18 及以上）和 pnpm（`npm i -g pnpm` 安装）
- 首次构建前端需要联网（`pnpm install` 下载 Vue3/Vite 依赖，仅首次；构建完成后可离线使用）

检查方法：打开命令行（Win+R 输入 `cmd` 回车），输入：

```bash
node -v
```

能显示版本号（如 v20.x）即可。没有的话去 https://nodejs.org 下载安装。

---

## 二、目录结构

```
wechat-automation/
├── start-xhs-web.bat      ← 双击启动网页版（首次自动安装依赖 + 构建前端）
├── 打开数据文件夹.bat      ← 打开 data/ 目录（生成物都在这，方便清理）
├── README.md              ← 使用文档
├── data/                  ← 🗑️ 所有生成物都在这里，整个删掉即可清理
│   ├── notes/             ← 下载的小红书/头条原图（按笔记 id 分文件夹）
│   └── output/            ← 每次上传的存档日志
├── server/                ← 🖥️ 后端（Node + Express）
│   ├── xhs-web-server.mjs ← 服务器（端口 9527，托管前端 + 提供 API）
│   ├── xhs-core.mjs       ← 核心业务逻辑（不要动）
│   ├── xhs-to-wechat.mjs  ← 命令行版（一条命令上传）
│   ├── delete-draft.mjs   ← 删除草稿/素材的小工具
│   ├── clean-orphans.mjs  ← 清理未使用素材
│   ├── config.json        ← 默认配置模板（不含密钥，可提交 git）
│   ├── config.local.json  ← 本地真实密钥（git 忽略，覆盖默认）
│   └── package.json       ← 后端依赖（express）
└── web/                   ← 🎨 前端（Vue3 + Vite）
    ├── package.json       ← 前端依赖与构建脚本
    ├── vite.config.js     ← 构建配置（含 /api 开发代理）
    ├── index.html         ← 前端入口
    ├── src/               ← Vue3 源码
    │   ├── main.js        ← 应用入口
    │   ├── App.vue        ← 根组件（双栏布局，窄屏自动堆叠）
    │   ├── store.js       ← 全局状态 + API 封装
    │   ├── styles.css     ← 全局样式（响应式）
    │   └── components/
    │       ├── UploadPanel.vue ← 上传面板（表单 + 密钥 + SSE 进度日志）
    │       └── DraftPanel.vue  ← 草稿箱管理（公网 IP/素材统计/清理/列表）
    └── dist/              ← 构建产物（pnpm run build 生成，git 忽略）
```

### 🗑️ 数据清理

程序文件只有根目录那几个（.mjs/.bat/config.json/README.md/web/）。**所有运行时生成的东西都放在 `data/` 文件夹**（下载的图片、上传存档），想清理就整个删除 `data/` 文件夹，不影响程序。也可以双击 `打开数据文件夹.bat` 查看里面有什么再手动删。

---

## 三、快速开始（网页版）

1. **双击 `start-xhs-web.bat`**（首次运行会自动安装前后端依赖并构建前端，需要联网，完成后自动启动服务器）
2. 浏览器打开 **http://127.0.0.1:9527**
3. 粘贴链接（每行一条，可多条排队）→ 选类型 → 点「🚀 开始上传」
   - **自动识别链接来源**：小红书（xiaohongshu.com / xhslink.com 短链）和今日头条（toutiao.com）都支持；自动分类规则两个平台统一：**描述文字≥150字→文章，否则→贴图**；手动选了贴图/文章则按所选来；其他平台链接会提示不支持
4. 页面实时显示进度，完成后显示草稿 media_id
5. 页面下方「🗑️ 草稿箱管理」面板：点「刷新列表」可查看公众号草稿箱（最近 20 条，含标题和时间），误传的草稿点「删除」一键清理
6. 「🧹 清理未使用素材」：扫描素材库，找出未被任何草稿/已发布内容引用的图片，一键批量删除（防止素材库堆到 5000 张上限）

上传结果进入公众号**草稿箱**，不会自动发布。去 mp.weixin.qq.com → 草稿箱 → 预览 → 发布即可。

### 网页各选项说明

| 选项 | 说明 |
|------|------|
| 上传类型 | `自动分类`（两个平台统一规则）：去掉话题后的描述文字 ≥150字→文章，<150字→贴图；`贴图`：多图直进草稿箱；`文章`：标题+正文+封面 |
| 标题 / 摘要 | 留空自动取笔记的标题和描述 |
| 公众号密钥 | 留空用 config.json 里的配置；填写则本次用填的（多账号切换用） |
| 仅试跑 dry-run | 勾选后只抓取下载、不上传，用于先验证 |

---

## 四、命令行用法

在 `wechat-automation` 目录打开命令行：

```bash
# 自动分类上传
node server/xhs-to-wechat.mjs "https://www.xiaohongshu.com/discovery/item/xxxx"

# 指定类型
node server/xhs-to-wechat.mjs "链接" --type sticker
node server/xhs-to-wechat.mjs "链接" --type news

# 只试跑不上传
node server/xhs-to-wechat.mjs "链接" --dry-run

# 自定义标题/摘要
node server/xhs-to-wechat.mjs "链接" --title "标题" --digest "摘要"
```

### 删除草稿/素材（误传时用）

```bash
node server/delete-draft.mjs draft     <media_id>   # 删除草稿
node server/delete-draft.mjs material  <media_id>   # 删除素材
```

media_id 在上传完成时日志里会打印。

### 清理未使用的素材（孤儿素材）

```bash
node server/clean-orphans.mjs --scan   # 只扫描，看有多少未被引用的图片
node server/clean-orphans.mjs          # 扫描 + 确认后删除
node server/clean-orphans.mjs --yes    # 跳过确认直接删除
```

---

## 五、公众号配置（config.json + config.local.json）

工具支持**双层配置**：

| 文件 | 作用 | git 忽略 |
|------|------|---------|
| `config.json` | 默认配置模板（不含真实密钥，**可提交 git 跟踪**） | ✅ 可跟踪 |
| `config.local.json` | 本地真实密钥（存在则逐项优先，删除则回退默认） | ⚠️ 忽略，绝不提交 |

```json
// config.json 默认模板（可提交 git；真实密钥放 config.local.json）
{
  "appId": "",
  "appSecret": "",
  "author": "公众号名称",
  "wechatApiBase": "https://api.weixin.qq.com/cgi-bin",
  "dataDir": "./data"
}
```

- **config.local.json** 只放需要覆盖的字段即可（如 appId/appSecret/author），启动时逐项覆盖默认值
- 本地文件不存在时，直接用 config.json 的默认值（即“默认模式”）；若默认 key 为空，需要补一份 config.local.json 才能上传
- AppID / AppSecret：mp.weixin.qq.com → 设置与开发 → 基本配置
- 也可以在网页上临时填密钥覆盖（不写入文件，关页面就没了）
- `config.json` 是模板可提交 git；`config.local.json` 含真实密钥，已在 .gitignore 中，不会提交

### 🔑 密钥优先级（从低到高）

```
config.json 默认配置
    ↓ 被覆盖
config.local.json 本地配置（存在则覆盖同名项）
    ↓ 被覆盖
页面输入（网页上填的 AppID/AppSecret/作者，仅当次任务生效）
```

页面填了就用页面的；页面留空 → 用 config.local.json；local 不存在 → 用 config.json 默认。

### ⚠️ 安全规则（全有或全无）

页面填了密钥后，**只用页面的 AppID+AppSecret（必须成对）**：
- 只填了一项 → 直接报错，绝不用配置文件补另一半（避免混搭发错账号）
- 两项都填但填错 → 报错失败，**绝不偷偷回退到配置文件的公众号**
- 想用配置文件 → 两个框都清空

### ♻️ 配置热更新

修改 `config.json` / `config.local.json` **不需要重启服务器**，下一次上传任务/接口请求自动生效（每次动态读取）。
页面填的密钥本来就是每次任务即时生效。
注：程序代码本身的更新需要重启；`dataDir` 目录配置仍以启动时为准。

### ⚠️ IP 白名单（必看）

微信要求调用接口的服务器 IP 在白名单内。如果上传报错：

```
Token获取失败: invalid ip xxx.xxx.xxx.xxx, not in whitelist
```

去 mp.weixin.qq.com → 设置与开发 → 基本配置 → **IP 白名单**，把提示的 IP 加进去（本机是家庭宽带的话 IP 可能变化，报错时按提示加最新的即可）。

**页面直接看当前 IP：** 网页「草稿箱管理」面板顶部有黄色提示条「🌐 当前公网 IP」，点一下自动复制，直接去公众号后台粘贴加白名单即可。

---

## 六、常见问题

**1. 双击 bat 后窗口一闪就关 / 打不开网页**
先确认装了 Node.js（`node -v`）。bat 末尾有 pause，报错会停在窗口里，把错误信息记下来。

**2. 端口被占用（EADDRINUSE）**
另一个实例在跑。改端口启动：
```bash
set PORT=18998
node xhs-web-server.mjs
```
然后访问 http://127.0.0.1:18998。

**3. 上传报 40001 invalid credential**
密钥不对，或 AppSecret 输错。检查 config.json / 页面填的密钥。

**4. 图片保存位置**
`notes/` 下按笔记 id 分文件夹（`notes/xhs_note_<id>/`），原图原样保存。

**5. 怎么停止服务器**
关掉那个黑色命令行窗口即可。

**6. 换电脑 / 给别人用**
把整个 `xhs-wechat-tool` 文件夹拷过去，装 Node.js，改 config.json 里的密钥即可。

---

## 七、安全提示

- 工具只监听本机（127.0.0.1），外部无法访问
- AppSecret 只在本地使用，不会上传到任何第三方
- 别把这个文件夹（尤其 config.json）发给别人或传网盘公开分享

---

## 八、正文内容规则（自动生成）

上传的贴图/文章正文自动包含：
- 笔记描述文字
- 全部话题标签（#公基常识 等，从笔记原样提取）
- 底部提示："⚠️ 内容整理自网络，仅供学习参考 ➡️ 欢迎关注+分享"

需要改底部提示的话，编辑 `xhs-core.mjs` 开头的 `FOOTER` 常量。

---

## 九、前端开发（可选）

网页界面是 **Vue3 + Vite** 工程（`web/` 目录），修改前端代码后需要重新构建：

```bash
cd web
pnpm install        # 首次安装依赖（只需一次）
pnpm run build      # 构建到 web/dist/（服务器自动托管）
pnpm run dev        # 开发模式：http://localhost:5173 热更新预览
```

- 只改后端（`server/xhs-core.mjs` / `server/xhs-web-server.mjs`）时无需重新构建
- 前端与后端通过 `/api/*` 接口通信，接口定义见 `server/xhs-web-server.mjs` 头部注释
- `pnpm run dev` 已配置 `/api` 代理：开发时先启动后端（`cd server && pnpm start`），再开 `pnpm run dev` 即可前后端分离联调
- `web/dist/` 不存在时访问页面会提示先运行 `pnpm run build`
