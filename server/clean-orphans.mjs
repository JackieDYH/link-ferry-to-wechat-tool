#!/usr/bin/env node
/**
 * clean-orphans.mjs — 清理公众号素材库中未被引用的图片（孤儿素材）
 *
 * 用法:
 *   node clean-orphans.mjs            扫描 + 确认后删除全部孤儿素材
 *   node clean-orphans.mjs --scan     只扫描，显示有多少，不删除
 *   node clean-orphans.mjs --yes      跳过确认直接删除
 *
 * 判定"未被引用"：素材库全部图片中，不在草稿箱(封面/贴图列表)和已发布内容里出现的
 */
import { getToken, loadConfig } from './xhs-core.mjs';

const CONFIG = loadConfig();
const cfg = { appId: CONFIG.appId, appSecret: CONFIG.appSecret, wechatApiBase: CONFIG.wechatApiBase };

const args = process.argv.slice(2);
const scanOnly = args.includes('--scan');
const yes = args.includes('--yes');

async function main() {
  console.log('🔑 获取 access_token...');
  const token = await getToken(cfg);
  const query = new URLSearchParams();
  query.set('access_' + 'token', token);
  console.log('  OK\n');

  // 1. 全部图片素材
  console.log('📦 扫描素材库图片...');
  const materials = [];
  let offset = 0;
  while (true) {
    const resp = await fetch(cfg.wechatApiBase + '/material/batchget_material?' + query.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'image', offset, count: 20 })
    });
    const j = await resp.json();
    if (j.errcode) throw new Error('获取素材失败(' + j.errcode + '): ' + j.errmsg);
    (j.item || []).forEach(it => materials.push({ media_id: it.media_id, name: it.name, update_time: it.update_time }));
    offset += (j.item || []).length;
    if (!j.item || j.item.length === 0 || offset >= j.total_count) break;
  }
  console.log(`  素材图片共 ${materials.length} 张`);

  // 2. 草稿引用的素材
  console.log('📝 扫描草稿箱引用...');
  const referenced = new Set();
  offset = 0;
  while (true) {
    const resp = await fetch(cfg.wechatApiBase + '/draft/batchget?' + query.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, count: 20, no_content: 0 })
    });
    const j = await resp.json();
    if (j.errcode) throw new Error('获取草稿失败(' + j.errcode + '): ' + j.errmsg);
    for (const it of (j.item || [])) {
      for (const ni of ((it.content && it.content.news_item) || [])) {
        if (ni.thumb_media_id) referenced.add(ni.thumb_media_id);
        for (const img of ((ni.image_info && ni.image_info.image_list) || [])) {
          if (img.image_media_id) referenced.add(img.image_media_id);
        }
      }
    }
    offset += (j.item || []).length;
    if (!j.item || j.item.length === 0 || offset >= j.total_count) break;
  }

  // 3. 已发布内容引用（保险）
  try {
    const resp = await fetch(cfg.wechatApiBase + '/freepublish/batchget?' + query.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: 0, count: 20, no_content: 0 })
    });
    const j = await resp.json();
    if (!j.errcode) {
      for (const it of (j.item || [])) {
        for (const ni of ((it.content && it.content.news_item) || [])) {
          if (ni.thumb_media_id) referenced.add(ni.thumb_media_id);
        }
      }
    }
  } catch { /* 忽略 */ }

  const orphans = materials.filter(m => !referenced.has(m.media_id));
  console.log(`  草稿/已发布引用 ${referenced.size} 张\n`);
  console.log('='.repeat(50));
  console.log(`🧹 结果: 素材共 ${materials.length} 张, 未被引用 ${orphans.length} 张`);
  console.log('='.repeat(50));

  if (scanOnly) {
    console.log('(--scan 模式，未删除)');
    return;
  }
  if (orphans.length === 0) {
    console.log('没有需要清理的素材 ✓');
    return;
  }
  if (!yes) {
    process.stdout.write(`确定删除这 ${orphans.length} 张未使用的素材吗？(y/N) `);
    const answer = await new Promise(resolve => {
      process.stdin.once('data', d => resolve(d.toString().trim().toLowerCase()));
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消');
      return;
    }
  }

  const allIds = orphans.map(o => o.media_id);
  let deleted = 0;
  let failed = 0;
  while (allIds.length > 0) {
    const batch = allIds.splice(0, 200);
    process.stdout.write(`  删除中... ${deleted} 张完成, 剩余 ${allIds.length + batch.length} 张\r`);
    for (const id of batch) {
      try {
        const resp = await fetch(cfg.wechatApiBase + '/material/del_material?' + query.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: id })
        });
        const j = await resp.json();
        if (j.errcode) failed++;
        else deleted++;
      } catch { failed++; }
    }
  }
  console.log(`\n✅ 完成: 删除 ${deleted} 张, 失败 ${failed} 张`);
}

main().catch(err => {
  console.error('\n❌ 失败: ' + err.message);
  process.exit(1);
});
