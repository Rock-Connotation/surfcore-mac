import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemoryV2Runtime } from '../lib/memory-v2-runtime.mjs';

const runtime = createMemoryV2Runtime({ stateDir: path.join(testHome, 'state'), charactersDir: path.join(testHome, 'characters'), getCharacter: () => ({ id: 'fixture', epoch: 1 }), currentDshUrl: () => 'http://127.0.0.1:1' });
try {
  const initialized = await runtime.initialize();
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  const policies = await runtime.activePolicies();
  assert.equal(policies.ok, true, JSON.stringify(policies));
  assert.ok(Array.isArray(policies.policies));
  console.log('PASS initialized Runtime activePolicies', JSON.stringify(policies));
} finally { await runtime.close(); }
