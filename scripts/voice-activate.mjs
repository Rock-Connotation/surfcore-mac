// 显式启用旧 voxd 语音；火山选择必须通过语音管理界面处理。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transactQqConfig } from '../src/qq-config-transaction.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dryRun = process.argv.includes('--dry-run');
const baseUrl = arg('base-url', 'http://127.0.0.1:8765');
const character = arg('character', 'xiaoyu');

function activate(cfg) {
  cfg.socialV2 ||= {}; cfg.socialV2.tools ||= {}; cfg.socialV2.voice ||= {};
  const voice = cfg.socialV2.voice;
  if (voice.tts?.cloudProvider === 'volc') throw Object.assign(new Error('当前选择火山语音，旧脚本不能修改该选择。'), { code: 'VOICE_SELECTION_MANAGED', hint: '请在语音管理中显式选择服务和开关。' });
  voice.enabled = true;
  cfg.socialV2.tools.sendVoice = true;
  voice.tts = { baseUrl, timeoutMs: 60000, maxChars: 120, character, ...(voice.tts || {}), enabled: true };
}

try {
  if (dryRun) {
    const text = fs.readFileSync(CFG, 'utf8').replace(/^﻿/, '');
    const draft = JSON.parse(text); activate(draft);
    console.log('[dry-run] 参数有效；未修改配置。');
  } else {
    const tx = transactQqConfig(CFG, activate, { requireExisting: true, allowVoiceSelection: true });
    console.log('已保存旧语音设置；重启桥接和 DSH 后生效。');
    if (tx.backup) console.log(`原配置备份：${path.relative(ROOT, tx.backup)}`);
  }
} catch (error) {
  const known = typeof error?.code === 'string' && Boolean(error.hint);
  console.error(`${known ? error.code : 'VOICE_ACTIVATE_FAILED'}：${known ? error.message : '保存失败。'} ${known ? error.hint : '检查配置后重试。'}`);
  process.exitCode = 1;
}
