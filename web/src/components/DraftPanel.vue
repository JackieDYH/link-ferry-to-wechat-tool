<script setup>
// 草稿箱管理面板：公网 IP + 素材统计 + 孤儿素材清理 + 草稿列表（跟随页面密钥账号）
import { ref, onMounted } from 'vue'
import { apiPost, apiGet, fmtTime } from '../store.js'

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

onMounted(() => { loadIp(); loadDrafts() })
</script>

<template>
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

    <p class="sub">公众号草稿箱（最近 20 条），删除草稿不会删除素材库里的图片。</p>

    <!-- 草稿列表 -->
    <div class="draft-list">
      <div v-if="loading" class="muted pad">加载中...</div>
      <div v-else-if="!drafts.length" class="muted pad">草稿箱为空，点「刷新列表」查看。</div>
      <div v-else v-for="it in drafts" :key="it.media_id" class="draft-row">
        <div class="draft-info">
          <div class="draft-title" :title="it.title">{{ it.title }}</div>
          <div class="muted">{{ fmtTime(it.update_time) }}</div>
        </div>
        <button class="btn danger sm" :disabled="deletingId === it.media_id" @click="removeDraft(it)">
          {{ deletingId === it.media_id ? '删除中...' : '删除' }}
        </button>
      </div>
    </div>
  </div>
</template>
