import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveVolcBudget, withVolcBudgetLock } from '../src/voice-volc-budget.js';
import { synthesizeToFile } from '../src/voice-tts.js';

const modulePath = fileURLToPath(new URL('../src/voice-volc-budget.js', import.meta.url));
const fixture = () => {
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'volc-limit-')), 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ socialV2: { voice: { maxPerMinute: 2, maxPerHour: 10, tts: { enabled: true, route: 'cloud', cloudProvider: 'volc', volcKeyId: 'fixture-id' } } } }));
  return { configFile, keyId: 'fixture-id' };
};
const ledger = config => path.join(path.dirname(config.configFile), 'state', 'volc-voice-budget.json');

test('失败请求保留预留，第三次不能出网，重启也不能绕过', async () => {
  const budget = fixture(); let requests = 0;
  const options = { text: '你好', apiKey: 'fake-key', provider: 'volc', budget, outDir: path.join(path.dirname(budget.configFile), 'audio'),
    fetchImpl: async () => { requests++; throw new Error('fixture'); } };
  for (let i = 0; i < 2; i++) await assert.rejects(synthesizeToFile(options), e => e.code === 'VOICE_VOLC_FAILED');
  await assert.rejects(synthesizeToFile(options), e => e.code === 'VOICE_VOLC_BUDGET_EXHAUSTED' && Boolean(e.hint));
  assert.equal(requests, 2);
  assert.equal(JSON.parse(fs.readFileSync(ledger(budget))).chars, 4);
  const code = `import {reserveVolcBudget} from ${JSON.stringify(pathToFileURL(modulePath).href)}; try {reserveVolcBudget({configFile:process.argv[1],text:'x'});process.exit(2)} catch(e) {process.exit(e.code==='VOICE_VOLC_BUDGET_EXHAUSTED'?0:3)}`;
  const status = await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', code, budget.configFile]); child.on('error', reject); child.on('exit', resolve); });
  assert.equal(status, 0);
});

test('没有持久预算上下文时绝不发请求', async () => {
  let calls = 0;
  await assert.rejects(synthesizeToFile({ text: '你好', apiKey: 'fixture-key', provider: 'volc', outDir: os.tmpdir(),
    fetchImpl: async () => { calls++; } }), e => e.code === 'VOICE_VOLC_BUDGET_UNAVAILABLE' && Boolean(e.hint));
  assert.equal(calls, 0);
});

test('切到旧云包或更换密钥后，旧调用不能再发火山请求', async () => {
  for (const update of [{ cloudProvider: 'voxd' }, { volcKeyId: 'new-id' }, { selectionRevision: 1 }]) {
    const budget = fixture(); let calls = 0;
    const config = JSON.parse(fs.readFileSync(budget.configFile));
    Object.assign(config.socialV2.voice.tts, update); fs.writeFileSync(budget.configFile, JSON.stringify(config));
    await assert.rejects(synthesizeToFile({ text: '你好', apiKey: 'fixture-key', provider: 'volc', budget, outDir: os.tmpdir(),
      fetchImpl: async () => { calls++; } }), e => e.code === 'VOICE_VOLC_CONFIG_CHANGED' && Boolean(e.hint));
    assert.equal(calls, 0); assert.equal(fs.existsSync(ledger(budget)), false);
  }
});

test('发起网络请求前持有与切换配置相同的锁', async () => {
  const budget = fixture(); let calls = 0;
  await assert.rejects(synthesizeToFile({ text: '你好', apiKey: 'fixture-key', provider: 'volc', budget, outDir: os.tmpdir(),
    fetchImpl: () => {
      calls++;
      assert.throws(() => withVolcBudgetLock(budget.configFile, () => {}), e => e.code === 'VOICE_VOLC_BUDGET_BUSY');
      throw new Error('offline fixture');
    } }), e => e.code === 'VOICE_VOLC_FAILED');
  assert.equal(calls, 1); assert.equal(JSON.parse(fs.readFileSync(ledger(budget))).chars, 2);
});

test('跨进程并发至多两次预留', async () => {
  const budget = fixture();
  const code = `import {reserveVolcBudget} from ${JSON.stringify(pathToFileURL(modulePath).href)};try{reserveVolcBudget({configFile:process.argv[1],text:'a'});process.exit(0)}catch(e){process.exit(e.code?.startsWith('VOICE_VOLC_BUDGET_')?1:2)}`;
  const statuses = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, budget.configFile]); child.on('error', reject); child.on('exit', resolve);
  })));
  assert(statuses.every(s => s === 0 || s === 1));
  assert(statuses.filter(s => s === 0).length <= 2);
  assert.equal(JSON.parse(fs.readFileSync(ledger(budget))).chars, statuses.filter(s => s === 0).length);
});

test('配置降低后旧调用者不能使用旧额度', () => {
  const budget = fixture(); const now = Date.UTC(2026, 10, 8);
  reserveVolcBudget({ ...budget, text: 'abc', monthlyQuota: 100, now });
  fs.writeFileSync(budget.configFile, JSON.stringify({ socialV2: { voice: { cloud: { monthlyQuota: 4 } } } }));
  assert.throws(() => reserveVolcBudget({ ...budget, text: 'de', monthlyQuota: 100, now: now + 60001 }), e => e.code === 'VOICE_VOLC_BUDGET_EXHAUSTED' && Boolean(e.hint));
});

test('火山专属限额与旧云限额分别保留并取较小值', () => {
  const budget = fixture(); const now = Date.UTC(2026, 10, 8);
  fs.writeFileSync(budget.configFile, JSON.stringify({ socialV2: { voice: { cloud: { monthlyQuota: 100 }, tts: { volcMonthlyQuota: 4 } } } }));
  reserveVolcBudget({ ...budget, text: 'abc', now });
  assert.throws(() => reserveVolcBudget({ ...budget, text: 'de', now: now + 60001 }), e => e.code === 'VOICE_VOLC_BUDGET_EXHAUSTED');
});

test('遗留锁和损坏配置不会触发云请求或重置账本', async () => {
  const budget = fixture();
  const state = path.join(path.dirname(budget.configFile), 'state');
  fs.mkdirSync(state); fs.mkdirSync(path.join(state, 'volc-voice-budget.lock'));
  assert.throws(() => reserveVolcBudget({ ...budget, text: 'a' }), e => e.code === 'VOICE_VOLC_BUDGET_BUSY' && Boolean(e.hint));
  assert.equal(fs.existsSync(ledger(budget)), false);
  const other = fixture(); fs.writeFileSync(other.configFile, '{broken'); let calls = 0;
  await assert.rejects(synthesizeToFile({ text: '你好', provider: 'volc', apiKey: 'fixture-key', budget: other, outDir: path.dirname(other.configFile), fetchImpl: async () => { calls++; } }),
    e => e.code === 'VOICE_VOLC_BUDGET_UNAVAILABLE' && Boolean(e.hint));
  assert.equal(calls, 0);
});

test('月额度、时钟回拨和损坏账本均拒绝', () => {
  const budget = fixture(); const now = Date.UTC(2026, 10, 8);
  reserveVolcBudget({ ...budget, text: '四个字呀', monthlyQuota: 5, now });
  assert.throws(() => reserveVolcBudget({ ...budget, text: '两个', monthlyQuota: 5, now: now + 60001 }), e => e.code === 'VOICE_VOLC_BUDGET_EXHAUSTED' && Boolean(e.hint));
  assert.throws(() => reserveVolcBudget({ ...budget, text: 'a', now: now - 1 }), e => e.code === 'VOICE_VOLC_BUDGET_UNAVAILABLE' && Boolean(e.hint));
  fs.writeFileSync(ledger(budget), '{broken');
  assert.throws(() => reserveVolcBudget({ ...budget, text: 'a', now: now + 1 }), e => e.code === 'VOICE_VOLC_BUDGET_UNAVAILABLE' && Boolean(e.hint));
});
