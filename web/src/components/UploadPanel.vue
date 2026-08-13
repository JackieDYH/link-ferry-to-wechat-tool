<script setup>
// 上传面板：链接输入 + 类型/标题/摘要 + 密钥 + 进度日志（SSE 实时推送）
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { creds, dryRun, apiPost } from '../store.js'

// —— 表单状态 ——
const links = ref('')
const type = ref('auto') // auto 自动分类 / sticker 贴图 / news 文章
const title = ref('')
const digest = ref('')
const credStatus = ref('') // 密钥测试结果提示

// —— 任务状态 ——
const running = ref(false)
const status = ref('就绪')
const logs = ref([]) // [{ type: info|ok|err|result, msg }]
const result = ref('')
let es = null // EventSource 句柄

// —— 日志自动滚动：用户停在底部时跟随最新，手动上翻看历史时不打扰 ——
const logEl = ref(null)
let stickToBottom = true // 是否跟随底部

// 用户滚动时判断是否仍在底部区域（距底 < 60px 视为在底部）
function onLogScroll() {
  const el = logEl.value
  if (!el) return
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

// 追加一行日志（新日志到达时若在底部则自动滚到最新）
function appendLine(type, msg) {
  logs.value.push({ type, msg })
  nextTick(() => {
    if (stickToBottom && logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  })
}

// 清空日志（回到跟随底部状态）
function clearLogs() {
  logs.value = []
  result.value = ''
  status.value = '就绪'
  stickToBottom = true
}

// 提交上传任务
async function startUpload() {
  const list = links.value.split('\n').map(s => s.trim()).filter(Boolean)
  if (!list.length) { alert('请先粘贴至少一条小红书/头条链接'); return }
  if (es) es.close()

  running.value = true
  status.value = '⏳ 处理中...'
  result.value = ''
  logs.value = []

  try {
    // 1. 提交任务，拿到 jobId
    const data = await apiPost('/api/upload', {
      links: list,
      type: type.value,
      title: title.value.trim() || null,
      digest: digest.value.trim() || null,
      dryRun: dryRun.value
    })

    // 2. 建立 SSE 连接，实时接收后端进度
    es = new EventSource(`/api/progress/${data.jobId}`)
    es.onmessage = ev => {
      const line = JSON.parse(ev.data)
      appendLine(line.type, line.msg)
      if (line.type === 'result' && line.msg.includes('全部完成')) {
        status.value = '✅ 完成'
        result.value = line.msg
        // 通知侧栏刷新本地记录 + 草稿列表
        window.dispatchEvent(new Event('xhs:data-changed'))
      }
    }
    es.onerror = () => {
      es.close()
      status.value = '✅ 完成（进度连接已关闭）'
      running.value = false
      window.dispatchEvent(new Event('xhs:data-changed'))
    }
    es.onopen = () => { status.value = '⏳ 处理中（进度连接成功）...' }
  } catch (e) {
    status.value = '❌ 出错'
    appendLine('err', '请求失败: ' + e.message)
    running.value = false
  }
}

// 测试密钥有效性（只测页面填的或配置文件的 appId/secret）
async function testCred() {
  credStatus.value = '测试中...'
  try {
    const d = await apiPost('/api/test-cred') // withCreds 自动附带页面填的密钥
    credStatus.value = d.ok ? `✅ 密钥有效（来源: ${d.source}）` : '❌ ' + d.error
  } catch (e) {
    credStatus.value = '❌ 测试失败: ' + e.message
  }
}

// 本地记录重传的进度也走本主日志区（与上传共用）：开始清日志、逐行追加、结束更新状态
function onReuploadStart(ev) {
  logs.value = []
  result.value = ''
  status.value = '⏳ 重新上传中...'
  stickToBottom = true
  appendLine('info', '🔄 重新上传（本地备份直传，不重新抓取）: ' + (ev.detail?.title || ''))
}
function onReuploadLog(ev) {
  appendLine(ev.detail.type, ev.detail.msg)
}
function onReuploadEnd() {
  status.value = '✅ 重新上传完成'
}

onMounted(() => {
  window.addEventListener('xhs:reupload-start', onReuploadStart)
  window.addEventListener('xhs:reupload-log', onReuploadLog)
  window.addEventListener('xhs:reupload-end', onReuploadEnd)
})

onUnmounted(() => {
  if (es) es.close()
  window.removeEventListener('xhs:reupload-start', onReuploadStart)
  window.removeEventListener('xhs:reupload-log', onReuploadLog)
  window.removeEventListener('xhs:reupload-end', onReuploadEnd)
})
</script>

<template>
  <div class="card">
    <h1>📤 链接转公众号上传工具 <span class="badge">小红书 · 今日头条</span></h1>
    <p class="sub">粘贴小红书笔记或今日头条文章链接，自动识别来源并上传到公众号草稿箱（贴图/文章），支持多条链接排队。</p>

    <label>小红书 / 头条链接（每行一条）</label>
    <textarea v-model="links" rows="4" placeholder="https://www.xiaohongshu.com/discovery/item/...&#10;https://www.toutiao.com/article/..."></textarea>

    <div class="row">
      <div>
        <label>上传类型</label>
        <select v-model="type">
          <option value="auto">自动分类</option>
          <option value="sticker">贴图（图片消息）</option>
          <option value="news">文章（图文消息）</option>
        </select>
      </div>
      <div>
        <label>标题（可选，留空用原文标题）</label>
        <input v-model="title" type="text" placeholder="留空自动">
      </div>
      <div>
        <label>摘要（可选）</label>
        <input v-model="digest" type="text" placeholder="留空自动">
      </div>
    </div>

    <!-- 密钥折叠区：多账号切换用（原生 details 展开/收起） -->
    <details class="creds">
      <summary>⚙️ 公众号密钥（可选，留空使用配置文件）</summary>
      <div class="row">
        <div><label>AppID</label><input v-model="creds.appId" type="text" placeholder="留空用配置文件" autocomplete="off"></div>
        <div><label>AppSecret</label><input v-model="creds.appSecret" type="password" placeholder="留空用配置文件" autocomplete="off"></div>
        <div><label>作者名</label><input v-model="creds.author" type="text" placeholder="留空用配置文件" autocomplete="off"></div>
      </div>
      <div class="cred-bar">
        <button class="btn ghost sm" @click="testCred">🧪 测试密钥</button>
        <span class="muted">{{ credStatus }}</span>
      </div>
      <p class="sub">填了就用页面输入的密钥上传；不填则用配置文件（config.json 默认 + config.local.json 本地覆盖）。</p>
    </details>

    <label class="check"><input v-model="dryRun" type="checkbox"> 仅试跑（dry-run，不上传）</label>

    <div class="actions">
      <button class="btn primary" :disabled="running" @click="startUpload">🚀 开始上传</button>
      <button class="btn ghost" @click="clearLogs">清空日志</button>
    </div>
  </div>

  <!-- 进度日志 -->
  <div class="card">
    <div class="statusbar"><span>{{ status }}</span></div>
    <div class="log" ref="logEl" @scroll="onLogScroll">
      <div v-for="(l, i) in logs" :key="i" :class="l.type">{{ l.msg }}</div>
    </div>
    <div v-if="result" class="result-box">{{ result }}</div>
  </div>
</template>
