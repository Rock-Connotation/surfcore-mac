#!/usr/bin/env node
// sync-dsh-port.mjs — 让 config.json 的 dsh.baseUrl 跟上「当前正在运行的 DSH 桌面端」。
//
// 为什么需要：DSH 桌面端每次启动会挑一个空闲回环端口（实测 28918 → 15016 → 41742 → 42212），
// 而桥接铸造的会话 Cookie 把 host:port 绑进了签名载荷，端口写错只会 401。
// 每次重启 DSH 都手改 config.json 太容易忘，所以启动桥接前先同步一次。
//
// 探测逻辑在 src/dsh-port.js（桥接自身启动时也用同一份兜底，避免两套实现漂移）。
//
// 用法：
//   node scripts/sync-dsh-port.mjs           # 把探测到的端口写回 config.json
//   node scripts/sync-dsh-port.mjs --print   # 只打印，不写文件
//   node scripts/sync-dsh-port.mjs --url http://127.0.0.1:3080  # 显式指定并写回
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDshBaseUrl } from '../src/dsh-port.js';
import { transactQqConfig } from '../src/qq-config-transaction.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');

function argv(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? '');
}

async function main() {
  const explicit = argv('--url');
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const current = String(config.dsh?.baseUrl ?? '');

  let next = explicit;
  if (!next) {
    next = await discoverDshBaseUrl();
    if (!next) {
      console.error('[sync-dsh-port] 没找到正在运行的 DSH Web（端口未探测到）。沿用 config.json 里的:', current);
      process.exit(1);
    }
  }
  next = next.replace(/\/+$/, '');

  if (current === next) {
    console.log(`[sync-dsh-port] 无需修改：${next}`);
    return;
  }
  if (process.argv.includes('--print')) {
    console.log(`[sync-dsh-port] 探测到 ${next}（config.json 当前是 ${current || '空'}）`);
    return;
  }
  const tx = transactQqConfig(CONFIG, draft => {
    if (draft.dsh != null && (typeof draft.dsh !== 'object' || Array.isArray(draft.dsh))) throw new Error('dsh 配置不是对象，已拒绝覆盖。');
    const previous = String(draft.dsh?.baseUrl ?? '');
    draft.dsh = { ...(draft.dsh || {}), baseUrl: next };
    return previous;
  }, { requireExisting: true });
  console.log(`[sync-dsh-port] 已更新 dsh.baseUrl：${tx.result || '空'} -> ${next}`);
}

main().catch((error) => {
  const known = typeof error?.code === 'string' && Boolean(error.hint);
  console.error(`[sync-dsh-port] ${known ? error.code : 'QQ_CONFIG_SYNC_FAILED'}：${known ? error.message : '端口配置同步失败。'} ${known ? error.hint : '检查配置后重试。'}`);
  process.exit(1);
});
