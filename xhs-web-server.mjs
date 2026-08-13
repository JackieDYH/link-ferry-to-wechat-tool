#!/usr/bin/env node
/**
 * xhs-web-server.mjs — 小红书/头条→公众号 网页上传工具（本地服务）
 *
 * 启动: node xhs-web-server.mjs          （默认 http://127.0.0.1:9527）
 *        PORT=8080 node xhs-web-server.mjs
 *
 * 接口:
 *   GET  /                       上传页面
 *   POST /api/upload             提交上传任务 { links:[...], type, title, digest, appId, appSecret, author, dryRun }
 *   GET  /api/progress/:jobId    SSE 进度推送（EventSource）
 *   GET  /api/drafts             草稿箱列表（最近 20 条）
 *   POST /api/delete             删除草稿 { media_id }
 *   GET  /api/materialcount      素材库数量统计（图片/图文/视频/语音）
 *   GET  /api/orphans            扫描未被引用的图片素材（孤儿）
 *   POST /api/orphans/delete     批量删除孤儿素材 { media_ids: [] }（每批最多 200）
 *   GET  /api/myip               当前电脑公网 IP（供公众号白名单使用）
 */
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { processNote, getToken, loadConfig, reuploadFromBackup } from './xhs-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = loadConfig();
const PORT = Number(process.env.PORT || 9527);
const INDEX_HTML = path.join(__dirname, 'web', 'index.html');

// 本地上传记录索引（模块级，供 startLocalJob / 路由共用）
const localIdxPath = () => path.join(path.resolve(__dirname, (loadConfig().dataDir || './data')), 'xhs-已上传.json');
const readLocalIdx = () => { try { return JSON.parse(fs.readFileSync(localIdxPath(), 'utf8')); } catch { return []; } };

const jobs = new Map(); // jobId -> { lines:[], status, result, clients:Set<res> }

/** 每次请求动态读取配置（支持不重启热更新） */
function apiCfg() {
  const c = loadConfig();
  return { appId: c.appId, appSecret: c.appSecret, author: c.author, wechatApiBase: c.wechatApiBase };
}

/** 管理接口用的配置：页面填了用页面的（逐字段补全），没填用配置文件 */
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

function pushLine(job, type, msg) {
  const line = { t: Date.now(), type, msg };
  job.lines.push(line);
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

function startJob(id, payload) {
  const job = { id, lines: [], status: 'running', result: null, clients: new Set(), links: payload.links, type: payload.type, dryRun: !!payload.dryRun };
  jobs.set(id, job);
  pushLine(job, 'info', `🆕 任务开始 (${payload.links.length} 条链接)`);

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
    // 任务结束 10 分钟后清理
    setTimeout(() => { jobs.delete(id); }, 10 * 60 * 1000);
  })().catch(e => {
    job.status = 'error';
    pushLine(job, 'err', `❌ 任务异常: ${e.message}`);
    for (const res of job.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    job.clients.clear();
  });
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // 上传页面
  if (u.pathname === '/' || u.pathname === '/index.html') {
    if (!fs.existsSync(INDEX_HTML)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('web/index.html 不存在');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(fs.readFileSync(INDEX_HTML));
    return;
  }

  // 提交任务
  if (u.pathname === '/api/upload' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const links = (body.links || []).map(s => String(s).trim()).filter(Boolean);
      if (links.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请至少输入一条小红书链接' }));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: id }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 当前公网 IP（供公众号白名单使用）
  if (u.pathname === '/api/myip' && req.method === 'GET') {
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ip }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 测试密钥是否可用（页面输入 or 配置文件）
  if (u.pathname === '/api/test-cred' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const pageAppId = (body.appId || '').trim();
      const pageSecret = (body.appSecret || '').trim();
      // 防呆：只填了其中一项会导致 AppID/AppSecret 混搭不匹配
      if (!!pageAppId !== !!pageSecret) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '页面只填了 AppID 或 AppSecret 其中一项：两项会分别从页面和配置文件取值，必然不匹配。请两项都填（同一公众号），或都留空' }));
        return;
      }
      const c0 = loadConfig();
      const cfg = {
        appId: pageAppId || c0.appId,
        appSecret: pageSecret || c0.appSecret,
        wechatApiBase: c0.wechatApiBase
      };
      if (!cfg.appId || !cfg.appSecret) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'AppID 或 AppSecret 为空（页面和配置文件都没有）' }));
        return;
      }
      const source = (body.appId && body.appSecret) ? '页面输入' : '配置文件';
      const token = await getToken(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, source, tokenLength: token.length }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 素材库统计
  if (u.pathname === '/api/materialcount' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : null;
      const cfg = apiCfgWith(body);
      const token = await getToken(cfg);
      const resp = await fetch(cfg.wechatApiBase + '/material/get_materialcount?' + new URLSearchParams({ ['access_' + 'token']: token }).toString());
      const j = await resp.json();
      if (j.errcode) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '获取素材统计失败(' + j.errcode + '): ' + j.errmsg }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        image_count: j.image_count || 0,
        video_count: j.video_count || 0,
        voice_count: j.voice_count || 0,
        news_count: j.news_count || 0
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 扫描未被引用的素材
  if (u.pathname === '/api/orphans' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : null;
      const cfg = apiCfgWith(body);
      const token = await getToken(cfg);
      const q = new URLSearchParams();
      q.set('access_' + 'token', token);

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

      // 2. 草稿引用的素材
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: materials.length,
        referenced: referenced.size,
        orphanCount: orphans.length,
        orphans
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 删除孤儿素材（每批最多 200，可多次调用）
  if (u.pathname === '/api/orphans/delete' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const ids = body.media_ids || [];
      if (ids.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '没有要删除的素材' }));
        return;
      }
      const batch = ids.slice(0, 200);
      const cfg = apiCfgWith(body);
      const token = await getToken(cfg);
      const q = new URLSearchParams();
      q.set('access_' + 'token', token);
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted, failed, remaining: ids.length - batch.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 本地上传记录（本地索引：展示/重新上传/删除）
  if (u.pathname === '/api/local-records' && (req.method === 'GET' || req.method === 'POST')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ records: readLocalIdx() }));
    return;
  }
  if (u.pathname === '/api/local-records/delete' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const time = Number(body.time);
      let idx = readLocalIdx();
      const item = idx.find(r => r.time === time);
      idx = idx.filter(r => r.time !== time);
      fs.writeFileSync(localIdxPath(), JSON.stringify(idx, null, 2), 'utf8');
      if (item && item.backup) { try { fs.unlinkSync(item.backup); } catch {} }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: !!item }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === '/api/local-records/delete-batch' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const times = (body.times || []).map(Number);
      let idx = readLocalIdx();
      const toDelete = idx.filter(r => times.includes(r.time));
      idx = idx.filter(r => !times.includes(r.time));
      fs.writeFileSync(localIdxPath(), JSON.stringify(idx, null, 2), 'utf8');
      for (const it of toDelete) { if (it.backup) { try { fs.unlinkSync(it.backup); } catch {} } }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: toDelete.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 本地备份重传：不重新抓取链接，直接用本地存档上传草稿
  if (u.pathname === '/api/local-reupload' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const rec = readLocalIdx().find(r => r.time === Number(body.time));
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '本地记录不存在（可能已被删除）' }));
        return;
      }
      if (!rec.backup || !fs.existsSync(rec.backup)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '本地存档文件不存在，无法用备份重传；请改用链接上传' }));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 草稿列表
  if (u.pathname === '/api/drafts' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : null;
      const cfg = apiCfgWith(body);
      const token = await getToken(cfg);
      const q = new URLSearchParams();
      q.set('access_' + 'token', token);
      const resp = await fetch(cfg.wechatApiBase + '/draft/batchget?' + q.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: 0, count: 20, no_content: 0 })
      });
      const j = await resp.json();
      if (j.errcode) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '获取草稿失败(' + j.errcode + '): ' + j.errmsg }));
        return;
      }
      const items = (j.item || []).map(it => ({
        media_id: it.media_id,
        title: (it.content && it.content.news_item && it.content.news_item[0] && it.content.news_item[0].title) || '(无标题)',
        update_time: it.update_time
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: j.total_count, items, account: cfg.author }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 删除草稿
  if (u.pathname === '/api/delete' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.media_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 media_id' }));
        return;
      }
      const cfg = apiCfgWith(body);
      const token = await getToken(cfg);
      const q = new URLSearchParams();
      q.set('access_' + 'token', token);
      const resp = await fetch(cfg.wechatApiBase + '/draft/delete?' + q.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id: body.media_id })
      });
      const j = await resp.json();
      if (j.errcode) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '删除失败(' + j.errcode + '): ' + j.errmsg }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // SSE 进度
  const prog = u.pathname.match(/^\/api\/progress\/([0-9a-f-]+)$/);
  if (prog) {
    const job = jobs.get(prog[1]);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '任务不存在或已过期' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    // 先补发历史行
    for (const line of job.lines) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }
    if (job.status === 'done' || job.status === 'error') {
      res.end();
      return;
    }
    job.clients.add(res);
    req.on('close', () => job.clients.delete(res));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🌐 小红书→公众号 网页上传工具已启动`);
  console.log(`   打开: http://127.0.0.1:${PORT}\n`);
  console.log(`   提示: 仅本机可访问；上传结果进入公众号草稿箱，不会直接发布`);
});
