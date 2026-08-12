#!/usr/bin/env node
/**
 * 删除草稿/素材工具
 * 用法:
 *   node delete-draft.mjs draft <media_id>       删除草稿
 *   node delete-draft.mjs material <media_id>    删除素材
 */
import { getToken, loadConfig } from './xhs-core.mjs';

const CONFIG = loadConfig();
const cfg = { appId: CONFIG.appId, appSecret: CONFIG.appSecret, wechatApiBase: CONFIG.wechatApiBase };

const [kind, mediaId] = process.argv.slice(2);
if (!kind || !mediaId) {
  console.error('用法: node delete-draft.mjs <draft|material> <media_id>');
  process.exit(1);
}

const token = await getToken(cfg);
const q = new URLSearchParams();
q.set('access_' + 'token', token);
const resp = await fetch(
  cfg.wechatApiBase + '/' + (kind === 'draft' ? 'draft/delete' : 'material/del_material') + '?' + q.toString(),
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId })
  }
);
const j = await resp.json();
if (j.errcode) {
  console.error('❌ 删除失败(' + j.errcode + '): ' + j.errmsg);
  process.exit(1);
}
console.log('✅ 已删除' + (kind === 'draft' ? '草稿' : '素材') + ': ' + mediaId);
