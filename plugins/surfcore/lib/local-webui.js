import { execFile } from 'node:child_process';

// This is deliberately not a general URL launcher: only an exact local WebUI origin is accepted.
export async function openLocalUrl(url, { platform = process.platform, comSpec = process.env.ComSpec, run = execFile } = {}) {
  const value = typeof url === 'string' ? url : '';
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(value);
  if (!match || match[0] !== value || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    return { ok: false, opened: false, code: 'webui.invalid-url', error: '本地控制台地址无效，未打开浏览器', hint: '检查 SnowLuma WebUI 端口是否为 1 至 65535。' };
  }
  const fail = (code) => ({ ok: false, opened: false, code, error: `无法自动打开 SnowLuma 控制台，请手动访问 ${value}`, hint: `请在浏览器打开 ${value} 后登录。` });
  let command;
  let args;
  const options = { timeout: 10000, windowsHide: true };
  if (platform === 'darwin') { command = '/usr/bin/open'; args = [value]; }
  else if (platform === 'win32') {
    command = comSpec || 'cmd.exe';
    args = ['/d', '/c', 'start', '""', `"${value}"`];
    options.windowsVerbatimArguments = true;
  } else if (platform === 'linux') { command = 'xdg-open'; args = [value]; }
  else return fail('webui.unsupported-platform');
  return new Promise((resolve) => {
    try {
      run(command, args, options, (error) => resolve(error ? fail('webui.open-failed') : { ok: true, opened: true }));
    } catch { resolve(fail('webui.open-failed')); }
  });
}
