import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, opening } from './sharing-fixture.mjs';

const f = await fixture(), original = Object.getOwnPropertyDescriptor(process, 'platform'), open = fs.openSync;
const directory = path.join(f.v2.stateDir, 'characters', 'alpha', 'douyin');
let unsupportedDirectoryOpens = 0;
// Model the documented OS boundary, while retaining the real service/store.
Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
fs.openSync = function (file, flags, ...rest) {
  if (file === directory && flags === 'r') {
    unsupportedDirectoryOpens++;
    throw Object.assign(new Error('Windows read-only directory handles cannot fsync'), { code: 'EPERM' });
  }
  return open.call(this, file, flags, ...rest);
};
try {
  const result = await opening(f);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(unsupportedDirectoryOpens, 0);
  console.log('Sharing platform boundary: fsynced append without unsupported Windows directory handle');
} finally { fs.openSync = open; Object.defineProperty(process, 'platform', original); await f.service.dispose(); await f.v2.close(); }
