import fs from 'node:fs';
import path from 'node:path';

export function blocked(code, error, hint) {
  console.error(JSON.stringify({ok:false,blocked:true,code,error,hint}));
  process.exit(1);
}
function findTool(name, override) {
  const executable=process.platform==='win32' ? `${name}.exe` : name;
  const candidates=override ? [override] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir=>path.resolve(dir,executable));
  for(const candidate of candidates) {
    if(!path.isAbsolute(candidate)) continue;
    try { if(!fs.statSync(candidate).isFile()) continue; fs.accessSync(candidate,fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  return null;
}
export function requireMedia() {
  const ffmpeg=findTool('ffmpeg',process.env.FFMPEG_PATH || process.env.FFMPEG);
  const ffprobe=findTool('ffprobe',process.env.FFPROBE_PATH || process.env.FFPROBE);
  if(!ffmpeg || !ffprobe) blocked('MEDIA_RUNTIME_NOT_FOUND','FFmpeg 或 FFprobe 不可用。','提供可执行的绝对路径 FFMPEG_PATH 和 FFPROBE_PATH，或将工具加入 PATH 后重试；涉及媒体的验证未执行。');
  return {ffmpeg,ffprobe};
}
export function requireAssets() {
  const value=process.env.ASR_ASSETS;
  if(!value || !path.isAbsolute(value)) blocked('ASR_ASSETS_REQUIRED','没有指定 ASR 评测资产目录。','将 ASR_ASSETS 设为包含已验证 whisper-cli、模型和样本的绝对目录后重试；真实推理未执行。');
  try { if(fs.statSync(value).isDirectory()) return fs.realpathSync(value); } catch {}
  blocked('ASR_ASSETS_UNAVAILABLE','指定的 ASR 评测资产目录不可用。','检查 ASR_ASSETS 目录和文件权限后重试；真实推理未执行。');
}
export function requireAssetFiles(base, files) {
  for (const file of files) {
    try { if(fs.statSync(path.join(base,file)).isFile()) continue; } catch {}
    blocked('ASR_ASSETS_INCOMPLETE','ASR 评测资产不完整。',`检查资产目录中是否存在 ${file}，然后重试；真实推理未执行。`);
  }
}
