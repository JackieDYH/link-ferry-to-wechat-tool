<script setup>
// 侧栏面板：本地上传记录（本地备份重传）+ 草稿箱管理（IP/素材统计/清理/列表/批量删除）
import { ref, onMounted, onUnmounted } from 'vue'
import { apiPost, apiGet, fmtTime, dryRun } from '../store.js'

// —— 状态 ——
const ip = ref('获取中...')
const ipRaw = ref('')
const account = ref('')
const matStat = ref('')
const drafts = ref([])
const loading = ref(false)
const cleaning = ref(false)
const cleanStatus = ref('')
const deletingId = ref('') // 正在删除的草稿 media_id
const selected = ref([])   // 已勾选的 media_id 列表

// —— 本地上传记录状态 ——
const records = ref([])        // 本地索引记录列表
const localLoading = ref(false)
const localSelected = ref([])  // 已勾选的记录 time（毫秒时间戳）
const reuploading = ref(null)  // 正在重传的记录 time
let localEs = null             // 重传的 EventSource 句柄

// 格式化本地记录时间（time 是 Date.now() 毫秒）
function fmtLocal(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// 当前公网 IP（供公众号白名单使用），点击复制
async function loadIp() {
  ip.value = '获取中...'
  try {
    const d = await apiGet('/api/myip')
    ipRaw.value = d.ip || ''
    ip.value = d.ip ? `当前公网 IP：${d.ip}（点此复制）` : '获取失败（点此重试）'
  } catch {
    ip.value = '获取失败（点此重试）'
  }
}

// 复制 IP 到剪贴板
async function copyIp() {
  if (!ipRaw.value) { loadIp(); return }
  try {
    await navigator.clipboard.writeText(ipRaw.value)
    ip.value = '✅ 已复制：' + ipRaw.value
    setTimeout(loadIp, 2000)
  } catch {
    prompt('请手动复制：', ipRaw.value)
  }
}

// 加载素材统计 + 草稿列表（一次性刷新）
async function loadDrafts() {
  loading.value = true
  drafts.value = []
  try {
    // 素材库占用统计（图片上限 5000 等）
    apiPost('/api/materialcount').then(d => {
      if (!d.error) matStat.value = `📦 素材库：图片 ${d.image_count}/5000 张 · 图文 ${d.news_count}/500 篇 · 视频 ${d.video_count}/1000 · 语音 ${d.voice_count}/1000`
    }).catch(() => {})
    // 最近 20 条草稿
    const d = await apiPost('/api/drafts')
    account.value = d.account ? `当前查看账号: ${d.account}` : ''
    drafts.value = d.items || []
  } catch (e) {
    matStat.value = '获取失败: ' + e.message
  }
  selected.value = []
  loading.value = false
}

// 删除单条草稿（二次确认防误删）
async function removeDraft(item) {
  if (!confirm(`确定删除草稿「${item.title || item.media_id}」？删除后不可恢复。`)) return
  deletingId.value = item.media_id
  try {
    await apiPost('/api/delete', { media_id: item.media_id })
    loadDrafts()
  } catch (e) {
    alert('删除失败: ' + e.message)
  }
  deletingId.value = ''
}

// —— 多选批量删除 ——
function toggleOne(id, checked) {
  if (checked) { if (!selected.value.includes(id)) selected.value.push(id) }
  else selected.value = selected.value.filter(x => x !== id)
}
function isSelected(id) { return selected.value.includes(id) }
function allChecked() {
  return drafts.value.length > 0 && selected.value.length === drafts.value.length
}
function toggleAll(checked) {
  selected.value = checked ? drafts.value.map(d => d.media_id) : []
}
async function batchDelete() {
  const ids = selected.value
  if (!ids.length) return
  if (!confirm(`确定删除选中的 ${ids.length} 篇草稿？删除后不可恢复。`)) return
  let ok = 0, fail = 0
  for (const id of ids) {
    try {
      await apiPost('/api/delete', { media_id: id })
      ok++
    } catch { fail++ }
  }
  alert(`批量删除完成：成功 ${ok} 篇${fail ? `，失败 ${fail} 篇` : ''}`)
  loadDrafts()
}

// 清理未被任何草稿/已发布内容引用的素材（孤儿），分批删除（每批最多 200）
async function cleanOrphans() {
  cleaning.value = true
  cleanStatus.value = '正在扫描素材库...'
  try {
    const d = await apiPost('/api/orphans')
    if (!d.orphanCount) { cleanStatus.value = '没有未使用的素材 ✓' ; cleaning.value = false; return }
    if (!confirm(`素材库共 ${d.total} 张图片，其中 ${d.orphanCount} 张未被任何草稿/已发布内容引用。\n确定删除这些未使用的素材吗？（不可恢复）`)) {
      cleaning.value = false
      return
    }
    const allIds = d.orphans.map(o => o.media_id)
    let deleted = 0, failed = 0
    while (allIds.length) {
      const batch = allIds.splice(0, 200)
      cleanStatus.value = `删除中... 已完成 ${deleted} 张，剩余 ${allIds.length + batch.length} 张`
      const r = await apiPost('/api/orphans/delete', { media_ids: batch })
      deleted += r.deleted
      failed += r.failed.length
    }
    cleanStatus.value = `✅ 清理完成：删除 ${deleted} 张${failed ? `，失败 ${failed} 张` : ''}`
    loadDrafts() // 刷新素材统计和草稿列表
  } catch (e) {
    cleanStatus.value = '清理失败: ' + e.message
  }
  cleaning.value = false
}

// ─── 本地上传记录：展示/重传/删除 ───
async function loadLocalRecords() {
  localLoading.value = true
  try {
    const d = await apiPost('/api/local-records')
    records.value = d.records || []
  } catch (e) {
    records.value = []
  }
  localSelected.value = []
  localLoading.value = false
}

// —— 本地记录多选 ——
function toggleLocalOne(t, checked) {
  if (checked) { if (!localSelected.value.includes(t)) localSelected.value.push(t) }
  else localSelected.value = localSelected.value.filter(x => x !== t)
}
function isLocalSelected(t) { return localSelected.value.includes(t) }
function localAllChecked() {
  return records.value.length > 0 && localSelected.value.length === records.value.length
}
function toggleLocalAll(checked) {
  localSelected.value = checked ? records.value.map(r => r.time) : []
}

// 删除单条本地记录（同时删备份 txt，不影响已上传的草稿）
async function removeLocal(rec) {
  if (!confirm(`删除这条本地记录？（不影响已上传的草稿）`)) return
  try {
    await apiPost('/api/local-records/delete', { time: rec.time })
    loadLocalRecords()
  } catch (e) { alert('删除失败: ' + e.message) }
}

// 批量删除本地记录
async function batchDeleteLocal() {
  const times = localSelected.value
  if (!times.length) return
  if (!confirm(`确定删除选中的 ${times.length} 条本地记录？（不影响已上传的草稿）`)) return
  try {
    await apiPost('/api/local-records/delete-batch', { times })
  } catch (e) { alert('删除失败: ' + e.message) }
  loadLocalRecords()
}

// 本地备份重传：不重新抓取链接，直接用本地存档上传新草稿（进度走主日志区）
async function reuploadLocal(rec) {
  if (localEs) localEs.close()
  reuploading.value = rec.time
  // 通知主日志区：开始新的重传（清空旧日志）
  window.dispatchEvent(new CustomEvent('xhs:reupload-start', { detail: { title: rec.title || rec.url } }))
  try {
    const data = await apiPost('/api/local-reupload', { time: rec.time, dryRun: dryRun.value })
    localEs = new EventSource(`/api/progress/${data.jobId}`)
    localEs.onmessage = ev => {
      const line = JSON.parse(ev.data)
      window.dispatchEvent(new CustomEvent('xhs:reupload-log', { detail: { type: line.type || 'info', msg: line.msg } }))
      if (line.type === 'result') {
        reuploading.value = null
        loadLocalRecords()
        loadDrafts() // 重传完成刷新草稿箱
        window.dispatchEvent(new CustomEvent('xhs:reupload-end'))
        localEs.close()
      }
    }
    localEs.onerror = () => {
      localEs.close()
      reuploading.value = null
      loadLocalRecords()
      loadDrafts()
      window.dispatchEvent(new CustomEvent('xhs:reupload-end'))
    }
  } catch (e) {
    window.dispatchEvent(new CustomEvent('xhs:reupload-log', { detail: { type: 'err', msg: '❌ ' + e.message } }))
    window.dispatchEvent(new CustomEvent('xhs:reupload-end'))
    reuploading.value = null
  }
}

// 上传面板完成后触发：刷新本地记录 + 草稿列表
function onDataChanged() {
  loadLocalRecords()
  loadDrafts()
}

onMounted(() => {
  loadIp(); loadDrafts(); loadLocalRecords()
  window.addEventListener('xhs:data-changed', onDataChanged)
})
onUnmounted(() => {
  window.removeEventListener('xhs:data-changed', onDataChanged)
  if (localEs) localEs.close()
})
</script>

<template>
  <!-- 本地上传记录：本地索引展示 / 备份直传重传 / 删除 -->
  <div class="card">
    <div class="statusbar">
      <span class="panel-title">📁 本地上传记录</span>
      <button class="btn ghost sm" :disabled="localLoading" @click="loadLocalRecords">{{ localLoading ? '加载中...' : '刷新' }}</button>
    </div>
    <p class="sub">本次上传的本地存档（可直接重传到草稿箱，无需重新抓取链接）</p>

    <div class="batch-bar">
      <label class="batch-label">
        <input type="checkbox" :checked="localAllChecked()" @change="e => toggleLocalAll(e.target.checked)"> 全选
      </label>
      <span class="muted">已选 {{ localSelected.length }} 条</span>
      <button class="btn danger sm" :disabled="!localSelected.length" @click="batchDeleteLocal">🗑️ 批量删除</button>
    </div>

    <div class="draft-list" style="max-height:34vh">
      <div v-if="localLoading" class="muted pad">加载中...</div>
      <div v-else-if="!records.length" class="muted pad">暂无本地上传记录</div>
      <div v-else v-for="rec in records" :key="rec.time" class="draft-row">
        <div class="draft-left">
          <input type="checkbox" class="draft-cb" :checked="isLocalSelected(rec.time)" @change="e => toggleLocalOne(rec.time, e.target.checked)">
          <div class="draft-info">
            <div class="draft-title" :title="rec.title">{{ rec.title || '(无标题)' }}</div>
            <div class="muted">{{ rec.type === 'sticker' ? '贴图' : '文章' }} · {{ fmtLocal(rec.time) }}{{ rec.mediaId ? ' ✅' : '' }}</div>
          </div>
        </div>
        <div class="draft-btns">
          <button class="btn ghost sm" :disabled="reuploading === rec.time" :title="'用本地备份直接重传（不重新抓取链接）'" @click="reuploadLocal(rec)">{{ reuploading === rec.time ? '重传中...' : '重传' }}</button>
          <button class="btn danger sm" @click="removeLocal(rec)">删</button>
        </div>
      </div>
    </div>

    <!-- 重传进度走主日志区（与上传共用），不在此处单独显示 -->
  </div>

  <div class="card">
    <div class="statusbar">
      <span class="panel-title">🗑️ 草稿箱管理</span>
      <button class="btn ghost sm" :disabled="loading" @click="loadDrafts">{{ loading ? '加载中...' : '刷新列表' }}</button>
    </div>

    <!-- 公网 IP 提示条（白名单用） -->
    <div class="ip-bar" :class="{ ok: ipRaw }" @click="copyIp">🌐 {{ ip }}</div>

    <div v-if="account" class="acct">{{ account }}</div>
    <div class="muted">{{ matStat }}</div>

    <div class="clean-bar">
      <button class="btn ghost sm" :disabled="cleaning" @click="cleanOrphans">🧹 清理未使用素材</button>
      <span class="muted">{{ cleanStatus }}</span>
    </div>

    <!-- 多选工具栏（紧贴列表上方） -->
    <div class="batch-bar">
      <label class="batch-label">
        <input type="checkbox" :checked="allChecked()" @change="e => toggleAll(e.target.checked)"> 全选
      </label>
      <span class="muted">已选 {{ selected.length }} 篇</span>
      <button class="btn danger sm" :disabled="!selected.length" @click="batchDelete">🗑️ 批量删除</button>
    </div>

    <p class="sub">公众号草稿箱（最近 20 条），删除草稿不会删除素材库里的图片。</p>

    <!-- 草稿列表 -->
    <div class="draft-list">
      <div v-if="loading" class="muted pad">加载中...</div>
      <div v-else-if="!drafts.length" class="muted pad">草稿箱为空，点「刷新列表」查看。</div>
      <div v-else v-for="it in drafts" :key="it.media_id" class="draft-row">
        <div class="draft-left">
          <input type="checkbox" class="draft-cb" :checked="isSelected(it.media_id)" @change="e => toggleOne(it.media_id, e.target.checked)">
          <div class="draft-info">
            <div class="draft-title" :title="it.title">{{ it.title }}</div>
            <div class="muted">{{ fmtTime(it.update_time) }}</div>
          </div>
        </div>
        <button class="btn danger sm" :disabled="deletingId === it.media_id" @click="removeDraft(it)">
          {{ deletingId === it.media_id ? '删除中...' : '删除' }}
        </button>
      </div>
    </div>
  </div>
</template>
