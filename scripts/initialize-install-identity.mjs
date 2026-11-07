#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSourceInstallationIdentity } from '../src/install-identity.js';

const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = initializeSourceInstallationIdentity(installRoot);
if (!result.ok) {
  console.error(`[install-identity] ${result.code}: ${result.error}`);
  console.error(`[install-identity] 下一步：${result.hint}`);
  process.exit(1);
}
console.log(`[install-identity] 已为当前源码安装写入身份：${result.identity.sourceRepo} @ ${result.identity.sourceCommit}`);
