import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preflightMemoryConfig } from '../../../src/core/memory-v2-preflight.js';

const dir = path.join(testHome, 'memory-v2');
const file = path.join(dir, 'routing.json');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, '{', { mode: 0o600 });
fs.writeFileSync(path.join(testHome, 'memory-control.sqlite'), '');
const read = fs.readFileSync;
for (const code of ['EACCES', 'ENOENT']) {
  fs.readFileSync = function (target, ...args) {
    if (target === file) throw Object.assign(new Error('injected read failure'), { code });
    return read.call(this, target, ...args);
  };
  const result = preflightMemoryConfig({ stateDir: testHome });
  console.log(`read ${code}: ${JSON.stringify(result)}`);
  assert.equal(result.state, 'unreadable');
  assert.equal(result.code, 'MEMORY_PREFLIGHT_UNREADABLE');
  assert.equal(result.ioCode, code);
  assert.ok(result.hint);
}
fs.readFileSync = read;
const stat = fs.lstatSync;
for (const code of ['EACCES', 'ENOENT']) {
  for (const stage of ['directory', 'route-again']) {
    let routeChecks = 0;
    fs.lstatSync = function (target, ...args) {
      if (target === file) routeChecks++;
      if ((stage === 'directory' && target === dir) || (stage === 'route-again' && target === file && routeChecks === 2)) {
        throw Object.assign(new Error('injected stat failure'), { code });
      }
      return stat.call(this, target, ...args);
    };
    const result = preflightMemoryConfig({ stateDir: testHome });
    console.log(`${stage} ${code}: ${JSON.stringify(result)}`);
    assert.equal(result.state, 'unreadable');
    assert.equal(result.code, 'MEMORY_PREFLIGHT_UNREADABLE');
    assert.equal(result.ioCode, code);
    assert.ok(result.hint);
  }
}
fs.lstatSync = stat;
const corrupt = preflightMemoryConfig({ stateDir: testHome });
console.log(`invalid JSON: ${JSON.stringify(corrupt)}`);
assert.equal(corrupt.state, 'corrupt');
assert.equal(corrupt.code, 'MEMORY_ROUTING_INVALID');
assert.equal(corrupt.problem, 'json');
assert.ok(corrupt.hint);
console.log('PASS preflight read errors and invalid JSON');
