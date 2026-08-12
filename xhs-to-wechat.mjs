#!/usr/bin/env node
/**
 * xhs-to-wechat.mjs — 小红书/头条链接一键上传微信公众号（CLI）
 *
 * 用法:
 *   node xhs-to-wechat.mjs "<小红书/头条链接>"              # 自动识别来源+自动分类上传
 *   node xhs-to-wechat.mjs "<链接>" --type sticker         # 强制传为 贴图(图片消息)
 *   node xhs-to-wechat.mjs "<链接>" --type news            # 强制传为 文章(图文消息)
 *   node xhs-to-wechat.mjs "<链接>" --dry-run              # 只抓取下载，不真正上传
 *   node xhs-to-wechat.mjs "<链接>" --title "标题" --digest "摘要"
 *
 * 类型说明:
 *   sticker (贴图) — 多张图片直接进草稿箱，适合答题卡/图片类笔记
 *   news    (文章) — 标题+正文+封面图，适合长文类内容
 *   auto    (默认) — 去掉话题后的描述文字 >=150 字判为文章，否则判为贴图（两平台统一规则）
 */
import { processNote } from './xhs-core.mjs';

function parseArgs(argv) {
  const args = { type: 'auto', dryRun: false, title: null, digest: null };
  const url = argv.find(a => a.startsWith('http'));
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--type':    args.type = (argv[++i] || 'auto').toLowerCase(); break;
      case '--title':   args.title = argv[++i]; break;
      case '--digest':  args.digest = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: break;
    }
  }
  if (!url) {
    console.error('❌ 用法: node xhs-to-wechat.mjs "<小红书链接>" [--type sticker|news|auto] [--dry-run]');
    process.exit(1);
  }
  if (!['sticker', 'news', 'auto'].includes(args.type)) {
    console.error(`❌ 未知类型: ${args.type}（可用: sticker / news / auto）`);
    process.exit(1);
  }
  return { ...args, url };
}

const args = parseArgs(process.argv.slice(2));

try {
  const result = await processNote({
    url: args.url,
    type: args.type,
    title: args.title,
    digest: args.digest,
    dryRun: args.dryRun,
    onProgress: (_type, msg) => console.log(msg)
  });
  if (!args.dryRun && result.mediaId) {
    console.log(`\n🎉 完成! media_id: ${result.mediaId}`);
  }
} catch (err) {
  console.error(`\n❌ 失败: ${err.message}`);
  process.exit(1);
}
