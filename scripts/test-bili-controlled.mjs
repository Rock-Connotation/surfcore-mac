import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const name of ['test-bili-round.mjs', 'test-bili-round-controller.mjs', 'test-bili-dynamic-receipt.mjs']) {
  execFileSync(process.execPath, [fileURLToPath(new URL('../plugins/surfcore/scripts/' + name, import.meta.url))], { stdio: 'inherit', timeout: 55000 });
}
