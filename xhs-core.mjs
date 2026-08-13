#!/usr/bin/env node
/**
 * xhs-core.mjs — 小红书/头条→公众号 核心流程模块（CLI 与网页版共用）
 *
 * processNote({ url, type, title, digest, dryRun, credentials, onProgress })
 *   credentials: { appId?, appSecret?, author? }  — 可选，覆盖默认配置（config.json + config.local.json 合并）
 *   onProgress(type: 'info'|'ok'|'err'|'result', message: string)
 *   返回 { mediaId, type, title, digest, imgDir, backupPath }
 *
 * 链接自动识别：toutiao.com → 头条文章；xiaohongshu.com / xhslink.com → 小红书笔记；其他 → 报错
 * 自动分类规则（两平台统一）：去掉话题后的描述文字 >=150 字 → 文章，否则 → 贴图
 * 配置：config.json 为默认模板（可提交 git），config.local.json 为本地密钥（覆盖优先，git 忽略）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 加载配置：config.json 为默认，若存在 config.local.json 则逐项覆盖（本地优先） */
export function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const localPath = path.join(__dirname, 'config.local.json');
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return { ...base, ...local };
    } catch (e) {
      console.error('⚠️ config.local.json 解析失败，忽略本地覆盖: ' + e.message);
    }
  }
  return base;
}

const CONFIG = loadConfig();
// 所有生成物（下载图片/上传存档）统一放 data/ 目录，方便清理
const DATA_DIR = path.resolve(__dirname, CONFIG.dataDir || './data');
const WORKSPACE = path.join(DATA_DIR, 'notes');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FOOTER = '\n⚠️ 内容整理自网络，仅供学习参考\n➡️ 欢迎关注+分享';

/** 合并默认配置与本次任务的覆盖配置；每次动态读取，支持不重启热更新
 *  规则：页面填了的字段用页面的，页面没填的字段用本地配置补全（config.json + config.local.json 合并） */
function resolveConfig(credentials = {}) {
  const base = loadConfig();
  return {
    appId: (credentials.appId || '').trim() || base.appId,
    appSecret: (credentials.appSecret || '').trim() || base.appSecret,
    author: (credentials.author || '').trim() || base.author,
    wechatApiBase: base.wechatApiBase
  };
}

// ─── 抓取与解析 ───

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) throw new Error(`页面抓取失败 HTTP ${resp.status}`);
  return resp.text();
}

export function parseNote(html, url) {
  const idMatch = url.match(/item\/([0-9a-f]{24})/);
  const noteId = idMatch ? idMatch[1] : (url.match(/([0-9a-f]{24})/) || [])[1] || Date.now().toString(16);

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/\s*-\s*小红书\s*$/, '').trim() : '小红书笔记';

  // 描述：优先 og:description（含完整正文+话题），其次 JSON 里的 desc，最后 name=description
  let desc = '';
  const ogDesc = html.match(/<meta property="og:description" content="([^"]*)"/);
  if (ogDesc) {
    desc = ogDesc[1];
  } else {
    const jsonDesc = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (jsonDesc) {
      desc = jsonDesc[1]
        .replace(/\\n/g, '\n')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } else {
      const nameDesc = html.match(/<meta name="description" content="([^"]*)"/);
      if (nameDesc) desc = nameDesc[1];
    }
  }
  desc = desc.replace(/^3\s*亿人的生活经验，都在小红书\s*/, '').trim();

  const images = [...html.matchAll(/<meta property="og:image" content="([^"]+)"/g)]
    .map(m => m[1])
    .map(u => (u.startsWith('//') ? 'https:' + u : u))
    .filter(u => u.includes('xhscdn') && !u.includes('picasso-static'))
    .map(u => u.replace(/^http:/, 'https:'));
  const uniqueImages = [...new Set(images)];

  if (uniqueImages.length === 0) {
    throw new Error('未从页面提取到图片（og:image），可能链接无效或需要登录');
  }
  return { noteId, title, desc, imageUrls: uniqueImages };
}

async function downloadImages(imageUrls, dir, onProgress) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const file = path.join(dir, `img_${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      const resp = await fetch(imageUrls[i], {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100) throw new Error('图片内容无效');
      fs.writeFileSync(file, buf);
      files.push(file);
      onProgress('ok', `下载图片 ${i + 1}/${imageUrls.length} ✓`);
    } catch (e) {
      onProgress('err', `下载图片 ${i + 1} 失败: ${e.message}`);
    }
  }
  return files; // 不在此抛错，允许纯文字文章（0 图）继续
}

// ─── 今日头条解析 ───

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

async function fetchToutiao(url) {
  const idMatch = url.match(/article\/(\d+)/) || url.match(/\/i(\d+)/) || url.match(/group_id=(\d+)/);
  if (!idMatch) throw new Error('无法识别头条文章ID');
  const id = idMatch[1];
  const resp = await fetch('https://m.toutiao.com/i' + id + '/info/', {
    headers: { 'User-Agent': MOBILE_UA },
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) throw new Error('头条文章抓取失败 HTTP ' + resp.status);
  const j = await resp.json();
  const d = (j && j.data) || {};
  if (!d.title && !d.content) throw new Error('头条文章内容为空（可能已删除或需登录）');
  // 清洗正文：去掉脚本/样式/iframe 和 on* 事件属性
  const contentHtml = (d.content || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  const images = [...contentHtml.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]);
  return {
    noteId: id,
    title: (d.title || '头条文章').trim(),
    desc: (d.abstract || '').trim(),
    imageUrls: [...new Set(images)],
    contentHtml,
    source: 'toutiao'
  };
}

// ─── 内容组装与分类 ───

export function buildContent(note, titleArg, digestArg) {
  const hashtags = [...note.desc.matchAll(/#[^\s#]+/g)].map(m => m[0]);
  let descText = note.desc.replace(/#[^\s#]+/g, '').trim();
  if (!descText) descText = note.title;
  const title = (titleArg || note.title).slice(0, 32);
  const digest = (digestArg || descText.slice(0, 120)).slice(0, 120);
  const tagLine = hashtags.length ? '\n' + hashtags.join(' ') : '';
  const content = `${descText}${tagLine}\n${FOOTER}`.trim();
  return { title, digest, content, hashtags, descText };
}

function classify(note, typeArg) {
  if (typeArg !== 'auto') return typeArg;
  const descText = note.desc.replace(/#[^\s#]+/g, '').trim();
  return descText.length >= 150 ? 'news' : 'sticker';
}

// ─── 微信 API（配置通过参数传入，支持按任务覆盖） ───

export async function getToken(cfg) {
  const keyName = 'app' + 'Secret';
  const q = new URLSearchParams();
  q.set('grant_type', 'client_credential');
  q.set('appid', cfg.appId);
  q.set('secret', cfg[keyName]);
  const url = cfg.wechatApiBase + '/token?' + q.toString();
  const r = await fetch(url);
  const j = await r.json();
  if (j.errcode) throw new Error('Token获取失败: ' + j.errmsg);
  return j.access_token;
}

async function uploadPermanentMaterial(cfg, token, filePath, label) {
  const buffer = fs.readFileSync(filePath);
  const boundary = '----WF' + Date.now() + Math.random().toString(36).slice(2, 8);
  const ext = path.extname(filePath).toLowerCase() || '.jpg';
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const safeName = 'mat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + ext;
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="media"; filename="' + safeName + '"\r\nContent-Type: ' + mime + '\r\n\r\n';
  const footer = '\r\n--' + boundary + '--\r\n';
  const body = Buffer.concat([Buffer.from(header, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);
  const resp = await fetch(
    cfg.wechatApiBase + '/material/add_material?access_token=' + token + '&type=image',
    { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body }
  );
  const j = await resp.json();
  if (j.errcode) throw new Error('上传永久素材失败(' + j.errcode + '): ' + j.errmsg);
  return { media_id: j.media_id, url: j.url };
}

async function uploadInlineImage(cfg, token, filePath) {
  const buffer = fs.readFileSync(filePath);
  const boundary = '----WF' + Date.now() + Math.random().toString(36).slice(2, 8);
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="media"; filename="img_' + Date.now() + '.jpg"\r\nContent-Type: image/jpeg\r\n\r\n';
  const footer = '\r\n--' + boundary + '--\r\n';
  const body = Buffer.concat([Buffer.from(header, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);
  const resp = await fetch(
    cfg.wechatApiBase + '/media/uploadimg?access_token=' + token,
    { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body }
  );
  const j = await resp.json();
  if (j.errcode) throw new Error('上传正文图片失败(' + j.errcode + '): ' + j.errmsg);
  return j.url;
}

async function createStickerDraft(cfg, token, title, digest, mediaIds, textContent) {
  const article = {
    article_type: 'newspic',
    title: title.slice(0, 32),
    author: cfg.author.slice(0, 16),
    digest: (digest || '').slice(0, 120),
    image_info: { image_list: mediaIds.map(id => ({ image_media_id: id })) },
    need_open_comment: 1,
    only_fans_can_comment: 0
  };
  if (textContent && textContent.trim()) article.content = textContent.trim().slice(0, 20000);
  const resp = await fetch(
    cfg.wechatApiBase + '/draft/add?access_token=' + token,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articles: [article] }) }
  );
  const j = await resp.json();
  if (j.errcode) throw new Error('创建贴图草稿失败(' + j.errcode + '): ' + j.errmsg);
  return j;
}

async function createNewsDraft(cfg, token, title, digest, htmlContent, thumbMediaId) {
  const article = {
    title: title.slice(0, 32),
    author: cfg.author.slice(0, 16),
    digest: (digest || '').slice(0, 120),
    content: htmlContent,
    thumb_media_id: thumbMediaId,
    need_open_comment: 1,
    only_fans_can_comment: 0
  };
  const resp = await fetch(
    cfg.wechatApiBase + '/draft/add?access_token=' + token,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articles: [article] }) }
  );
  const j = await resp.json();
  if (j.errcode) throw new Error('创建图文草稿失败(' + j.errcode + '): ' + j.errmsg);
  return j;
}

// ─── 主流程 ───

export async function processNote({ url, type = 'auto', title = null, digest = null, dryRun = false, credentials = null, onProgress = () => {} }) {
  const p = (type2, msg) => onProgress(type2, msg);
  const cfg = resolveConfig(credentials || {});
  const credSource = (credentials && (credentials.appId || credentials.appSecret))
    ? '页面输入' : '配置文件';
  p('info', '🔑 公众号: ' + cfg.author + '（密钥来源: ' + credSource + '）');

  p('info', '📥 开始处理: ' + url);

  let note;
  let finalType;
  const isToutiao = /toutiao\.com/.test(url);
  const isXhs = /xiaohongshu\.com/.test(url) || /xhslink\.com/.test(url);
  if (isToutiao) {
    note = await fetchToutiao(url);
    // 头条链接：自动/贴图/文章 都按统一规则（描述≥150字→文章，否则→贴图）
    finalType = classify(note, type);
    p('info', '📰 识别为今日头条文章' + (finalType === 'sticker' ? '，按【贴图】上传' : '，按【文章】上传'));
  } else if (isXhs) {
    p('info', '📕 识别为小红书笔记');
    p('info', '🔍 抓取页面...');
    const html = await fetchText(url);
    note = parseNote(html, url);
    finalType = classify(note, type);
  } else {
    throw new Error('无法识别的链接类型：目前仅支持小红书(xiaohongshu.com / xhslink.com)和今日头条(toutiao.com)');
  }
  p('ok', '标题: ' + note.title);
  p('ok', '图片数量: ' + note.imageUrls.length + ' 张');

  const imgDir = path.join(WORKSPACE, 'xhs_note_' + note.noteId);
  p('info', '⬇️  下载图片...');
  const files = await downloadImages(note.imageUrls, imgDir, p);

  // 纯文字文章（如头条无配图）：下载占位封面，保证能建草稿（仅文章模式）
  if (files.length === 0) {
    if (note.contentHtml && finalType === 'news') {
      p('info', '📄 无配图，使用占位封面');
      try {
        const ph = path.join(imgDir, 'cover_placeholder.jpg');
        const resp = await fetch('https://picsum.photos/seed/tt' + note.noteId + '/900/500', {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(20000)
        });
        fs.writeFileSync(ph, Buffer.from(await resp.arrayBuffer()));
        files.push(ph);
        note.imageUrls.push('placeholder');
      } catch (e) {
        throw new Error('占位封面下载失败: ' + e.message);
      }
    } else {
      throw new Error('没有可上传的图片（该文章无配图，贴图模式需要图片）');
    }
  }

  const { title: finalTitle, digest: finalDigest, content } = buildContent(note, title, digest);
  p('info', '📋 类型: ' + (finalType === 'sticker' ? '贴图(newspic)' : '文章(news)'));
  p('ok', '标题: ' + finalTitle);
  p('ok', '摘要: ' + finalDigest);

  if (dryRun) {
    p('info', '⏸️ dry-run 模式，跳过上传。');
    p('info', '📝 正文预览: ' + content.slice(0, 500) + (content.length > 500 ? '...' : ''));
    return { mediaId: null, type: finalType, title: finalTitle, digest: finalDigest, imgDir, backupPath: null, dryRun: true };
  }

  p('info', '🔑 获取 access_token...');
  const token = await getToken(cfg);
  p('ok', 'access_token OK');

  let mediaId;
  if (finalType === 'sticker') {
    p('info', '⬆️  上传 ' + files.length + ' 张贴图图片...');
    const mediaIds = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const r = await uploadPermanentMaterial(cfg, token, files[i], '贴图' + (i + 1));
        mediaIds.push(r.media_id);
        p('ok', '贴图 ' + (i + 1) + '/' + files.length + ' media_id: ' + r.media_id);
      } catch (e) {
        p('err', '贴图' + (i + 1) + ' 上传失败: ' + e.message);
      }
    }
    if (mediaIds.length === 0) throw new Error('贴图图片上传全部失败');
    const result = await createStickerDraft(cfg, token, finalTitle, finalDigest, mediaIds, content);
    mediaId = result.media_id;
    p('ok', '✅ 贴图草稿创建成功! media_id: ' + mediaId);
  } else {
    p('info', '⬆️  上传封面图...');
    const cover = await uploadPermanentMaterial(cfg, token, files[0], '封面');
    p('ok', '封面 media_id: ' + cover.media_id);
    p('info', '⬆️  上传正文图片 ' + files.length + ' 张...');
    let htmlParts = [];
    if (note.contentHtml) {
      // 文章正文（头条等来源）：段落+配图，图片替换为微信CDN
      const srcToUrl = {};
      for (let i = 0; i < files.length; i++) {
        const src = note.imageUrls[i];
        if (!src || src === 'placeholder' || srcToUrl[src]) continue;
        try {
          const wechatUrl = await uploadInlineImage(cfg, token, files[i]);
          srcToUrl[src] = wechatUrl;
          p('ok', '正文图 ' + (i + 1) + '/' + files.length + ' ✓');
        } catch (e) {
          p('err', '正文图' + (i + 1) + ' 上传失败: ' + e.message);
        }
      }
      let articleHtml = note.contentHtml.replace(/<img([^>]*?)src="([^"]+)"([^>]*)>/g, (m, pre, src, post) => {
        return srcToUrl[src] ? '<img' + pre + 'src="' + srcToUrl[src] + '"' + post + '>' : m;
      });
      articleHtml += '<p>' + FOOTER.replace(/</g, '&lt;').replace(/\n/g, '<br/>') + '</p>';
      htmlParts.push(articleHtml);
    } else {
      if (content) htmlParts.push('<p>' + content.replace(/</g, '&lt;').replace(/\n/g, '<br/>') + '</p>');
      for (let i = 0; i < files.length; i++) {
        try {
          const wechatUrl = await uploadInlineImage(cfg, token, files[i]);
          htmlParts.push('<img src="' + wechatUrl + '" style="width:100%;"/>');
          p('ok', '正文图 ' + (i + 1) + '/' + files.length + ' ✓');
        } catch (e) {
          p('err', '正文图' + (i + 1) + ' 上传失败: ' + e.message);
        }
      }
    }
    const result = await createNewsDraft(cfg, token, finalTitle, finalDigest, htmlParts.join(''), cover.media_id);
    mediaId = result.media_id;
    p('ok', '✅ 图文草稿创建成功! media_id: ' + mediaId);
  }

  const outputDir = path.join(DATA_DIR, 'xhs-backup');
  fs.mkdirSync(outputDir, { recursive: true });
  const backup = path.join(outputDir, 'xhs_' + note.noteId + '_' + finalType + '_' + Date.now() + '.txt');
  fs.writeFileSync(backup, '标题: ' + finalTitle + '\n摘要: ' + finalDigest + '\n类型: ' + finalType + '\n图片: ' + files.join('\n') + '\n\n' + content, 'utf8');
  p('ok', '💾 本地存档: ' + backup);

  // 本地上传记录索引（供网页版「本地上传记录」展示/重新上传/删除）
  try {
    const idxPath = path.join(DATA_DIR, 'xhs-已上传.json');
    let idx = [];
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
    idx.unshift({
      url,
      title: finalTitle,
      digest: (finalDigest || '').slice(0, 100),
      type: finalType,
      time: Date.now(),
      mediaId: mediaId || '',
      backup,
      imageCount: (files || []).length
    });
    fs.writeFileSync(idxPath, JSON.stringify(idx.slice(0, 100), null, 2), 'utf8');
  } catch (e) { p('warn', '⚠️ 本地上传记录写入失败: ' + e.message); }

  p('result', '🎉 完成! 草稿已存入公众号「' + cfg.author + '」草稿箱（' + (finalType === 'sticker' ? '贴图' : '文章') + '）media_id: ' + mediaId);

  return { mediaId, type: finalType, title: finalTitle, digest: finalDigest, imgDir, backupPath: backup };
}

// ─── 本地备份解析与重传（不重新抓取链接，直接用本地存档上传草稿） ───

/** 解析备份 txt：
 *  格式：
 *    标题: xxx\n摘要: xxx\n类型: sticker|news\n图片: <路径1>\n<路径2>...\n\n<正文>  */
export function parseBackupFile(text) {
  const lines = String(text || '').split('\n');
  const title = (lines[0] || '').replace(/^标题:\s*/, '');
  const digest = (lines[1] || '').replace(/^摘要:\s*/, '');
  const type = (lines[2] || '').replace(/^类型:\s*/, '').trim();
  const images = [];
  let idx = 3;
  if (lines[idx] && lines[idx].startsWith('图片:')) {
    images.push(lines[idx].replace(/^图片:\s*/, '').trim());
    idx++;
    while (idx < lines.length && lines[idx].trim() !== '') { images.push(lines[idx].trim()); idx++; }
  }
  while (idx < lines.length && lines[idx].trim() === '') idx++; // 跳过分隔空行
  const content = lines.slice(idx).join('\n').trim();
  return { title, digest, type, images, content };
}

export async function reuploadFromBackup({ backupPath, dryRun = false, credentials = null, onProgress = () => {} }) {
  const p = (t, m) => onProgress(t, m);
  const cfg = resolveConfig(credentials || {});
  const credSource = (credentials && (credentials.appId || credentials.appSecret))
    ? '页面输入' : '配置文件';
  p('info', '🔑 公众号: ' + cfg.author + '（密钥来源: ' + credSource + '）');
  p('info', '📂 读取本地存档: ' + backupPath);

  let text;
  try { text = fs.readFileSync(backupPath, 'utf8'); }
  catch (e) { throw new Error('本地存档文件不存在或已删除，无法用备份重传：' + e.message); }
  const b = parseBackupFile(text);
  const finalType = (b.type === 'news' || b.type === 'sticker') ? b.type : 'auto';
  p('ok', '标题: ' + b.title);
  p('ok', '类型: ' + (finalType === 'sticker' ? '贴图(newspic)' : '文章(news)'));

  // 检查本地图片是否存在（备份 txt 里存的是绝对路径）
  const files = [];
  for (const f of b.images) {
    if (!f) continue;
    if (fs.existsSync(f)) files.push(f);
    else p('warn', '⚠️ 本地图片已不存在（目录被清理?）: ' + f);
  }
  if (files.length === 0) throw new Error('本地图片全部缺失，无法用备份重传；请改用链接重新抓取');
  p('ok', '本地图片可用 ' + files.length + ' 张（无需重新下载）');

  if (dryRun) {
    p('info', '⏸️ dry-run 模式，跳过上传。');
    p('info', '📝 正文预览: ' + b.content.slice(0, 500) + (b.content.length > 500 ? '...' : ''));
    return { mediaId: null, type: finalType, title: b.title, digest: b.digest, backupPath, dryRun: true };
  }

  p('info', '🔑 获取 access_token...');
  const token = await getToken(cfg);
  p('ok', 'access_token OK');

  let mediaId;
  if (finalType === 'sticker') {
    p('info', '⬆️ 上传 ' + files.length + ' 张贴图图片（本地直传，不走抓取）...');
    const mediaIds = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const r = await uploadPermanentMaterial(cfg, token, files[i], '贴图' + (i + 1));
        mediaIds.push(r.media_id);
        p('ok', '贴图 ' + (i + 1) + '/' + files.length + ' media_id: ' + r.media_id);
      } catch (e) { p('err', '贴图' + (i + 1) + ' 上传失败: ' + e.message); }
    }
    if (mediaIds.length === 0) throw new Error('贴图图片上传全部失败');
    const result = await createStickerDraft(cfg, token, b.title, b.digest, mediaIds, b.content);
    mediaId = result.media_id;
    p('ok', '✅ 贴图草稿创建成功! media_id: ' + mediaId);
  } else {
    p('info', '⬆️ 上传封面图（本地直传）...');
    const cover = await uploadPermanentMaterial(cfg, token, files[0], '封面');
    p('ok', '封面 media_id: ' + cover.media_id);
    p('info', '⬆️ 上传正文图片 ' + files.length + ' 张...');
    const htmlParts = [];
    if (b.content) htmlParts.push('<p>' + b.content.replace(/</g, '&lt;').replace(/\n/g, '<br/>') + '</p>');
    for (let i = 0; i < files.length; i++) {
      try {
        const wechatUrl = await uploadInlineImage(cfg, token, files[i]);
        htmlParts.push('<img src="' + wechatUrl + '" style="width:100%;"/>');
        p('ok', '正文图 ' + (i + 1) + '/' + files.length + ' ✓');
      } catch (e) { p('err', '正文图' + (i + 1) + ' 上传失败: ' + e.message); }
    }
    // 注意：备份正文已含页脚（buildContent 时拼入 FOOTER），这里不再重复加
    const result = await createNewsDraft(cfg, token, b.title, b.digest, htmlParts.join(''), cover.media_id);
    mediaId = result.media_id;
    p('ok', '✅ 图文草稿创建成功! media_id: ' + mediaId);
  }

  p('result', '🎉 重传完成! 草稿已存入公众号「' + cfg.author + '」草稿箱（' + (finalType === 'sticker' ? '贴图' : '文章') + '）media_id: ' + mediaId);
  return { mediaId, type: finalType, title: b.title, digest: b.digest, backupPath, dryRun: false };
}
