// 全局状态 + API 封装
// 密钥采用"全有或全无"策略：页面填了就用页面的，留空则走后端配置文件（config.json + config.local.json）
import { reactive, ref } from 'vue'

// 页面临时填写的公众号密钥（不写文件，关页面即失效）
export const creds = reactive({
  appId: '',
  appSecret: '',
  author: ''
})

// dry-run 偏好（上传面板与本地重传共用）
export const dryRun = ref(false)

// 管理类接口统一附带页面密钥（填了则管理面板跟随该账号，留空用配置文件账号）
function withCreds(extra = {}) {
  return {
    appId: creds.appId.trim() || null,
    appSecret: creds.appSecret.trim() || null,
    author: creds.author.trim() || null,
    ...extra
  }
}

// POST JSON，返回解析后的对象（接口错误时抛异常）
export async function apiPost(path, extra = {}) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withCreds(extra))
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

// GET JSON
export async function apiGet(path) {
  const resp = await fetch(path)
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

// 格式化时间戳为本地时间字符串
export function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
}
