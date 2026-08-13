#!/usr/bin/env node
/**
 * xhs-web-server.mjs — 小红书/头条→公众号 网页上传工具（Express + Vue3 前端）
 *
 * 启动: node xhs-web-server.mjs          （默认 http://127.0.0.1:9527）
 *       PORT=8080 node xhs-web-server.mjs
 *
 * 前端: Vue3 + Vite 构建产物 dist/（npm run build 生成，由本服务托管）
 *
 * 接口:
 *   POST /api/upload             提交上传任务 { links, type, title, digest, appId, appSecret, author, dryRun }
 *   GET  /api/progress/:jobId    SSE 进度推送（EventSource）
 *   GET/POST /api/drafts         草稿箱列表（最近 20 条；GET 用配置账号，POST 可带页面密钥）
 *   POST /api/delete             删除草稿 { media_id }
 *   GET/POST /api/materialcount  素材库数量统计（图片/图文/视频/语音）
 *   GET/POST /api/orphans        扫描未被引用的图片素材（孤儿）
 *   POST /api/orphans/delete     批量删除孤儿素材 { media_ids }（每批最多 200）
 *   GET  /api/myip               当前电脑公网 IP（供公众号白名单使用）
 *   POST /api/test-cred          测试密钥有效性
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { processNote, getToken, loadConfig, reuploadFromBackup } from './xhs-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = loadConfig();
const PORT = Number(process.env.PORT || 9527);
const DIST_DIR = path.join(__dirname, '..', 'web', 'dist'); // Vue3 构建产物（web/dist）

const app = express();
app.use(express.json({ limit: '2mb' })); // 统一 JSON 请求体解析

/* ==================== 工具函数 ==================== */

// 管理接口配置：页面填了用页面的（逐字段），留空用配置文件（config.json + config.local.json）
function apiCfgWith(body) {
  const base = loadConfig();
  const pageAppId = ((body && body.appId) || '').trim();
  const pageSecret = ((body && body.appSecret) || '').trim();
  const pageAuthor = ((body && body.author) || '').trim();
  return {
    appId: pageAppId || base.appId,
    appSecret: pageSecret || base.appSecret,
    author: pageAuthor || base.author,
    wechatApiBase: base.wechatApiBase
  };
}

/* ==================== 任务队列 + SSE 进度 ==================== */

const jobs = new Map(); // jobId -> { id, lines, status, result, clients, ... }

// 推送一行日志给所有已连接的 SSE 客户端，并追加到历史
function pushLine(job, type, msg) {
  const line = { t: Date.now(), type, msg };
  job.lines.push(line);
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch { /* 客户端已断开，忽略 */ }
  }
}

// 启动一个上传任务：逐条链接处理，完成后关闭所有 SSE 连接
function startJob(id, payload) {
  const job = { id, lines: [], status: 'running', result: null, clients: new Set(), links: payload.links, type: payload.type, dryRun: !!payload.dryRun };
  jobs.set(id, job);
  pushLine(job, 'info', `🔄 任务开始 (${payload.links.length} 条链接)`);

  (async () => {
    let okCount = 0;
    for (let i = 0; i < payload.links.length; i++) {
      const url = payload.links[i].trim();
      if (!url) continue;
      pushLine(job, 'info', `\n========== [${i + 1}/${payload.links.length}] ${url.slice(0, 80)} ==========`);
      try {
        const result = await processNote({
          url,
          type: payload.type || 'auto',
          title: payload.title || null,
          digest: payload.digest || null,
          dryRun: payload.dryRun,
          credentials: payload.credentials,
          onProgress: (t, m) => pushLine(job, t, m)
        });
        okCount++;
        pushLine(job, 'result', `✅ 第 ${i + 1} 条完成${result.dryRun ? '（dry-run）' : ` media_id: ${result.mediaId}`}`);
      } catch (e) {
        pushLine(job, 'err', `❌ 第 ${i + 1} 条失败: ${e.message}`);
      }
    }
    job.status = 'done';
    job.result = { ok: okCount, total: payload.links.length };
    pushLine(job, 'result', `🏁 全部完成: 成功 ${okCount}/${payload.links.length}${payload.dryRun ? '（dry-run 未实际上传）' : ''}`);
    for (const res of job.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    job.clients.clear();
    // 任务结束 10 分钟后清理内存
    setTimeout(() => { jobs.delete(id); }, 10 * 60 * 1000);
  })().catch(e => {
    job.status = 'error';
    pushLine(job, 'err', `💥 任务异常: ${e.message}`);
    for (const res of job.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    job.clients.clear();
  });
}

// 本地上传记录索引（模块级，供 startLocalJob / 路由共用）
// DATA_DIR 与 xhs-core 保持一致：dataDir 相对 server/ 解析（config 里为 ../output/cache）
const localIdxPath = () => path.join(path.resolve(__dirname, (loadConfig().dataDir || './data')), 'xhs-已上传.json');
const readLocalIdx = () => { try { return JSON.parse(fs.readFileSync(localIdxPath(), 'utf8')); } catch { return []; } };

// 本地备份重传任务：不重新抓取链接，直接用本地存档上传草稿
function startLocalJob(id, rec, payload) {
  const job = { id, lines: [], status: 'running', result: null, clients: new Set(), links: [rec.url || ''], type: rec.type, dryRun: !!payload.dryRun };
  jobs.set(id, job);
  pushLine(job, 'info', `🆕 本地备份重传: ${rec.title || rec.url || ''}`);
  (async () => {
    try {
      const result = await reuploadFromBackup({
        backupPath: rec.backup,
        dryRun: payload.dryRun,
        credentials: payload.credentials,
        onProgress: (t, m) => pushLine(job, t, m)
      });
      // 重传成功后更新索引里的 media_id（指向新草稿）
      if (result.mediaId) {
        try {
          const idx = readLocalIdx();
          const it = idx.find(r => r.time === rec.time);
          if (it) {
            it.mediaId = result.mediaId;
            fs.writeFileSync(localIdxPath(), JSON.stringify(idx, null, 2), 'utf8');
          }
        } catch (e) { pushLine(job, 'warn', '⚠️ 索引 media_id 更新失败: ' + e.message); }
      }
      job.status = 'done';
      job.result = { ok: 1, total: 1 };
      pushLine(job, 'result', `🏁 重传完成: ${result.dryRun ? '（dry-run 未实际上传）' : 'media_id: ' + result.mediaId}`);
      for (const res of job.clients) { try { res.end(); } catch { /* ignore */ } }
      job.clients.clear();
      setTimeout(() => { jobs.delete(id); }, 10 * 60 * 1000);
    } catch (e) {
      job.status = 'error';
      pushLine(job, 'err', `❌ 重传失败: ${e.message}`);
      for (const res of job.clients) { try { res.end(); } catch { /* ignore */ } }
      job.clients.clear();
    }
  })();
}

/* ==================== API 路由 ==================== */

// 提交上传任务
app.post('/api/upload', async (req, res) => {
  try {
    const body = req.body || {};
    const links = (body.links || []).map(s => String(s).trim()).filter(Boolean);
    if (links.length === 0) {
      res.status(400).json({ error: '请至少输入一条小红书链接' });
      return;
    }
    const id = randomUUID();
    const pageAppId = (body.appId || '').trim();
    const pageSecret = (body.appSecret || '').trim();
    startJob(id, {
      links,
      type: ['sticker', 'news', 'auto'].includes(body.type) ? body.type : 'auto',
      title: body.title || null,
      digest: body.digest || null,
      dryRun: !!body.dryRun,
      credentials: {
        appId: body.appId || '',
        appSecret: body.appSecret || '',
        author: body.author || ''
      }
    });
    // 服务端视角：实际收到的密钥状态
    pushLine(jobs.get(id), 'info', '🔐 服务端收到: appId' + (pageAppId ? ' 已填(' + pageAppId.slice(0, 6) + '…)' : ' 留空') + ', appSecret' + (pageSecret ? ' 已填(' + pageSecret.length + '位)' : ' 留空'));
    res.json({ jobId: id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// SSE 进度推送：先补发历史行，再挂到客户端集合
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('retry: 3000\n\n');
  for (const line of job.lines) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }
  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
});

// 草稿箱列表（最近 20 条）；GET 用配置账号，POST 可带页面密钥
const draftsHandler = async (req, res) => {
  try {
    const cfg = apiCfgWith(req.body || {});
    const token = await getToken(cfg);
    const q = new URLSearchParams();
    q.set('access_token', token);
    const resp = await fetch(cfg.wechatApiBase + '/draft/batchget?' + q.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: 0, count: 20, no_content: 0 })
    });
    const j = await resp.json();
    if (j.errcode) {
      res.status(500).json({ error: '获取草稿失败(' + j.errcode + '): ' + j.errmsg });
      return;
    }
    const items = (j.item || []).map(it => ({
      media_id: it.media_id,
      title: (it.content && it.content.news_item && it.content.news_item[0] && it.content.news_item[0].title) || '(无标题)',
      update_time: it.update_time
    }));
    res.json({ total: j.total_count, items, account: cfg.author });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
app.get('/api/drafts', draftsHandler);
app.post('/api/drafts', draftsHandler);

// 删除草稿
app.post('/api/delete', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.media_id) {
      res.status(400).json({ error: '缺少 media_id' });
      return;
    }
    const cfg = apiCfgWith(body);
    const token = await getToken(cfg);
    const q = new URLSearchParams();
    q.set('access_token', token);
    const resp = await fetch(cfg.wechatApiBase + '/draft/delete?' + q.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: body.media_id })
    });
    const j = await resp.json();
    if (j.errcode) {
      res.status(500).json({ error: '删除失败(' + j.errcode + '): ' + j.errmsg });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 素材库数量统计
const materialHandler = async (req, res) => {
  try {
    const cfg = apiCfgWith(req.body || {});
    const token = await getToken(cfg);
    const resp = await fetch(cfg.wechatApiBase + '/material/get_materialcount?' + new URLSearchParams({ access_token: token }).toString());
    const j = await resp.json();
    if (j.errcode) throw new Error('获取素材统计失败(' + j.errcode + '): ' + j.errmsg);
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
app.get('/api/materialcount', materialHandler);
app.post('/api/materialcount', materialHandler);

// 扫描未被任何草稿/已发布内容引用的图片素材（孤儿）
const orphansHandler = async (req, res) => {
  try {
    const cfg = apiCfgWith(req.body || {});
    const token = await getToken(cfg);
    const q = new URLSearchParams();
    q.set('access_token', token);

    // 1. 全部图片素材（分页拉取）
    const materials = [];
    let offset = 0;
    while (true) {
      const resp = await fetch(cfg.wechatApiBase + '/material/batchget_material?' + q.toString(), {
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

    // 2. 草稿引用的素材（封面 thumb_media_id + 正文图片 image_media_id）
    const referenced = new Set();
    offset = 0;
    while (true) {
      const resp = await fetch(cfg.wechatApiBase + '/draft/batchget?' + q.toString(), {
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

    // 3. 已发布内容引用的素材（保险，出错忽略）
    try {
      const resp = await fetch(cfg.wechatApiBase + '/freepublish/batchget?' + q.toString(), {
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
    res.json({
      total: materials.length,
      referenced: referenced.size,
      orphanCount: orphans.length,
      orphans
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
app.get('/api/orphans', orphansHandler);
app.post('/api/orphans', orphansHandler);

// 批量删除孤儿素材（每批最多 200，可多次调用）
app.post('/api/orphans/delete', async (req, res) => {
  try {
    const body = req.body || {};
    const ids = body.media_ids || [];
    if (ids.length === 0) {
      res.status(400).json({ error: '没有要删除的素材' });
      return;
    }
    const batch = ids.slice(0, 200);
    const cfg = apiCfgWith(body);
    const token = await getToken(cfg);
    const q = new URLSearchParams();
    q.set('access_token', token);
    let deleted = 0;
    const failed = [];
    for (const id of batch) {
      try {
        const resp = await fetch(cfg.wechatApiBase + '/material/del_material?' + q.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: id })
        });
        const j = await resp.json();
        if (j.errcode) failed.push({ media_id: id, error: j.errmsg });
        else deleted++;
      } catch (e) {
        failed.push({ media_id: id, error: e.message });
      }
    }
    res.json({ deleted, failed, remaining: ids.length - batch.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 当前公网 IP（供公众号白名单使用）：多服务轮询，校验 IP 格式
app.get('/api/myip', async (req, res) => {
  try {
    const services = ['https://api.ipify.org', 'https://ipinfo.io/ip', 'https://icanhazip.com'];
    let ip = null;
    for (const s of services) {
      try {
        const r = await fetch(s, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const t = (await r.text()).trim();
          if (/^[0-9a-fA-F.:]+$/.test(t)) { ip = t; break; }
        }
      } catch { /* 换下一个 */ }
    }
    res.json({ ip });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 测试密钥有效性（含防呆：只填一项直接报错，避免混搭）
app.post('/api/test-cred', async (req, res) => {
  try {
    const body = req.body || {};
    const pageAppId = (body.appId || '').trim();
    const pageSecret = (body.appSecret || '').trim();
    if (!!pageAppId !== !!pageSecret) {
      res.json({ ok: false, error: '页面只填了 AppID 或 AppSecret 其中一项：两项会分别从页面和配置文件取值，必然不匹配。请两项都填（同一公众号），或都留空' });
      return;
    }
    const c0 = loadConfig();
    const cfg = {
      appId: pageAppId || c0.appId,
      appSecret: pageSecret || c0.appSecret,
      wechatApiBase: c0.wechatApiBase
    };
    if (!cfg.appId || !cfg.appSecret) {
      res.json({ ok: false, error: 'AppID 或 AppSecret 为空（页面和配置文件都没有）' });
      return;
    }
    const source = (body.appId && body.appSecret) ? '页面输入' : '配置文件';
    const token = await getToken(cfg);
    res.json({ ok: true, source, tokenLength: token.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ==================== 本地上传记录（本地索引：展示/重新上传/删除） ==================== */

// 本地上传记录列表
app.post('/api/local-records', (req, res) => {
  res.json({ records: readLocalIdx() });
});

// 删除单条本地记录（同时删备份 txt，不影响已上传的草稿）
app.post('/api/local-records/delete', async (req, res) => {
  try {
    const body = req.body || {};
    const time = Number(body.time);
    let idx = readLocalIdx();
    const item = idx.find(r => r.time === time);
    idx = idx.filter(r => r.time !== time);
    fs.writeFileSync(localIdxPath(), JSON.stringify(idx, null, 2), 'utf8');
    if (item && item.backup) { try { fs.unlinkSync(item.backup); } catch {} }
    res.json({ ok: true, deleted: !!item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 批量删除本地记录
app.post('/api/local-records/delete-batch', async (req, res) => {
  try {
    const body = req.body || {};
    const times = (body.times || []).map(Number);
    let idx = readLocalIdx();
    const toDelete = idx.filter(r => times.includes(r.time));
    idx = idx.filter(r => !times.includes(r.time));
    fs.writeFileSync(localIdxPath(), JSON.stringify(idx, null, 2), 'utf8');
    for (const it of toDelete) { if (it.backup) { try { fs.unlinkSync(it.backup); } catch {} } }
    res.json({ ok: true, deleted: toDelete.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 本地备份重传：不重新抓取链接，直接用本地存档上传草稿（SSE 进度同 /api/progress/:jobId）
app.post('/api/local-reupload', async (req, res) => {
  try {
    const body = req.body || {};
    const rec = readLocalIdx().find(r => r.time === Number(body.time));
    if (!rec) {
      res.status(404).json({ error: '本地记录不存在（可能已被删除）' });
      return;
    }
    if (!rec.backup || !fs.existsSync(rec.backup)) {
      res.json({ error: '本地存档文件不存在，无法用备份重传；请改用链接上传' });
      return;
    }
    const id = randomUUID();
    startLocalJob(id, rec, {
      dryRun: !!body.dryRun,
      credentials: {
        appId: (body.appId || '').trim(),
        appSecret: (body.appSecret || '').trim(),
        author: (body.author || '').trim()
      }
    });
    res.json({ jobId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==================== 静态资源（Vue3 构建产物 dist/） ==================== */

// 静态文件：index.html / assets/* 等
app.use(express.static(DIST_DIR, {
  index: 'index.html',
  setHeaders: res => res.setHeader('Cache-Control', 'no-store')
}));

// SPA 兜底：非 API 路径统一返回入口页（前端路由由 Vue Router 处理）
app.get(/^\/(?!api\/).*/, (req, res) => {
  const entry = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(entry)) {
    res.status(500).send('dist/index.html 不存在，请先运行: npm run build');
    return;
  }
  res.sendFile(entry);
});

/* ==================== 启动 ==================== */

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🌐 小红书→公众号 网页上传工具已启动`);
  console.log(`   打开: http://127.0.0.1:${PORT}\n`);
  console.log(`   提示: 仅本机可访问；上传结果进入公众号草稿箱，不会直接发布`);
});
