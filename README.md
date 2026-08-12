# link-ferry-to-wechat-tool - 202607

# 小红书/头条 → 公众号 工具（独立版）- By Jackie

纯 Node.js v24 实现，**无需安装任何依赖**（只用到 Node 内置模块），解压即用。

---

## 一、目录结构

```
小红书工具包/
├── xhs-web-server.mjs     # 网页版服务（端口 9527）
├── xhs-to-wechat.mjs      # 命令行版入口
├── xhs-core.mjs           # 抓取/上传核心（不要删）
├── start-xhs-web.bat      # 双击启动网页版
├── web/index.html         # 网页操作界面（不要删）
├── config.json            # 配置模板（dataDir 等）
├── config.local.json      # ⚠️ 真实凭据（AppID/AppSecret/作者），勿外传
└── 使用说明.md            # 本文件
```

---

## 二、启动网页版（推荐）

1. 双击 `start-xhs-web.bat`
2. 浏览器打开 **http://127.0.0.1:9527**
3. 那个黑色命令行窗口**不要关**（关了服务就停），最小化即可
4. 用完后直接关黑窗口 = 停止服务

---

## 三、网页版使用步骤

1. 复制小红书笔记 / 今日头条文章链接（支持多行，每行一条，自动排队）
2. 选择类型：自动分类 / 贴图（图片消息）/ 文章（图文消息）
3. 点「🚀 开始上传」→ 实时看进度 → 完成后去公众号后台草稿箱检查、群发
4. 右侧「草稿箱管理」：刷新/删除/批量删除、素材统计、清理未使用素材、查看公网 IP（点复制，加白名单用）

---

## 四、命令行版

```bash
node xhs-to-wechat.mjs "https://www.xiaohongshu.com/..."   # 自动识别+自动分类上传
node xhs-to-wechat.mjs "链接" --type sticker               # 贴图
node xhs-to-wechat.mjs "链接" --type news                  # 文章
node xhs-to-wechat.mjs "链接" --dry-run                    # 只抓取不上传
node xhs-to-wechat.mjs "链接" --title "标题" --digest "摘要"
```

---

## 五、配置

- `config.local.json` 里已填好公众号凭据（AppID/AppSecret/作者），一般不用动
- 多账号切换：网页版「⚙️ 公众号密钥」折叠区临时填写（填了用页面的，AppID/Secret 必须成对填；留空用配置文件）
- ⚠️ **IP 白名单**：换电脑/换网络后，去 mp.weixin.qq.com → 设置与开发 → 基本配置，把当前公网 IP（网页版顶部有提示条，点复制）加入白名单，否则报 `invalid ip`

---

## 六、常见问题

| 现象 | 解决 |
|---|---|
| 页面打不开 | 确认 bat 的黑窗口还开着；浏览器 Ctrl+F5 强制刷新 |
| 上传报 invalid ip | 公众号后台加当前 IP 到白名单 |
| 上传报 40001 | AppID/Secret 不对，检查 config.local.json 或页面填的密钥 |
| 端口 9527 被占用 | 命令行执行 `set PORT=9529` 再 `node xhs-web-server.mjs`，访问对应端口 |
| 删除草稿失败 | 微信接口偶发超时，重试即可 |

---
