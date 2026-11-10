import path from 'node:path';
import { initializeQqConfig } from '../src/qq-config-transaction.js';

try {
  const root = path.resolve(process.argv[2] || '.');
  const result = initializeQqConfig(path.join(root, 'config.json'), path.join(root, 'config.example.json'));
  console.log(result.created ? '已生成 config.json' : 'config.json 已存在，未覆盖');
} catch (error) {
  const known = typeof error?.code === 'string' && Boolean(error.hint);
  console.error(`${known ? error.code : 'QQ_CONFIG_INIT_FAILED'}：${known ? error.message : '配置初始化失败。'} ${known ? error.hint : '检查安装目录后重试。'}`);
  process.exitCode = 1;
}
