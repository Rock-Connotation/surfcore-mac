// FFmpeg/FFprobe discovery and capability diagnostics shared by media tools and ASR.
// Explicit overrides win and fail visibly; Finder launches also search Homebrew's usual paths.
import { accountBili } from './state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const probeCache = new Map()

function toolNames(kind, platform) {
  if (platform === 'win32') return [`${kind}.exe`, kind]
  return [kind]
}

function commonDirectories(platform, env) {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']
  if (platform === 'win32') return [
    env.ProgramFiles ? path.join(env.ProgramFiles, 'ffmpeg', 'bin') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
  ].filter(Boolean)
  return ['/usr/local/bin', '/usr/bin', '/opt/bin']
}

function candidatesFor(kind, { env, platform, fsApi }) {
  const overrideNames = kind === 'ffmpeg' ? ['FFMPEG', 'FFMPEG_PATH'] : ['FFPROBE_PATH', 'FFPROBE']
  const override = overrideNames.map((name) => [name, String(env[name] ?? '').trim()]).find(([, value]) => value)
  if (override) return [{ path: override[1], source: override[0], explicit: true }]

  const names = toolNames(kind, platform)
  const items = []
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const directory of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) items.push({ path: path.join(directory, name), source: 'PATH' })
  }
  for (const directory of commonDirectories(platform, env)) {
    for (const name of names) items.push({ path: path.join(directory, name), source: 'system-location' })
  }
  for (const name of names) {
    items.push({ path: path.join(ROOT, 'bin', name), source: 'plugin-bin' })
    items.push({ path: accountBili('bin', name), source: 'bili-bin' })
  }

  // Jianying's FFmpeg is local-only convenience; it is never bundled or required.
  if (kind === 'ffmpeg' && platform === 'win32') {
    const base = path.join(env.LOCALAPPDATA || '', 'JianyingPro', 'Apps')
    try {
      for (const version of fsApi.readdirSync(base)) {
        items.push({ path: path.join(base, version, 'ffmpeg.exe'), source: 'jianying-local' })
      }
    } catch {}
  }
  return items
}

function binaryArch(executable, { platform, spawnSyncImpl }) {
  if (platform !== 'darwin') return 'unknown'
  const result = spawnSyncImpl('/usr/bin/file', ['-b', executable], {
    encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024,
  })
  if (result?.status !== 0) return 'unknown'
  const text = String(result.stdout ?? '')
  const hasArm = /\barm64\b|\baarch64\b/i.test(text)
  const hasX64 = /\bx86_64\b|\bamd64\b/i.test(text)
  if (hasArm && hasX64) return 'universal'
  if (hasArm) return 'arm64'
  if (hasX64) return 'x64'
  return 'unknown'
}

function runToolProbe(executable, kind, { spawnSyncImpl, timeoutMs = 5000 }) {
  const identity = (() => {
    try {
      const stat = fs.statSync(executable)
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch { return '' }
  })()
  const cacheKey = identity ? `${kind}\0${executable}\0${identity}` : ''
  if (cacheKey && probeCache.has(cacheKey)) return probeCache.get(cacheKey)

  const result = spawnSyncImpl(executable, ['-hide_banner', '-version'], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  })
  let failure = ''
  if (result?.error) failure = result.error.message
  else if (result?.status !== 0) failure = `版本探测退出码 ${result?.status ?? '未知'}`
  const version = String(result?.stdout || result?.stderr || '').split(/\r?\n/)[0].trim()
  const checked = failure
    ? { ok: false, reason: failure }
    : { ok: true, version: version || '版本信息为空' }

  if (cacheKey) probeCache.set(cacheKey, checked)
  return checked
}

function capabilityProbe(executable, kind, { spawnSyncImpl, timeoutMs }) {
  if (kind === 'ffmpeg') {
    const result = spawnSyncImpl(executable, ['-hide_banner', '-filters'], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    })
    const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
    return {
      audioFilters: result?.status === 0,
      resample: result?.status === 0 && /\baresample\b/.test(output),
    }
  }
  const result = spawnSyncImpl(executable, ['-hide_banner', '-h', 'full'], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  })
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  return {
    streamInspection: result?.status === 0 && /-show_entries/.test(output),
    jsonOutput: result?.status === 0 && /json/.test(output),
  }
}

function inspectTool(kind, {
  env = process.env,
  platform = process.platform,
  fsApi = fs,
  spawnSyncImpl = spawnSync,
  probe = null,
  timeoutMs = 5000,
} = {}) {
  const candidates = candidatesFor(kind, { env, platform, fsApi })
  for (const candidate of candidates) {
    const executable = path.resolve(candidate.path)
    try {
      const stat = fsApi.statSync(executable)
      if (!stat.isFile()) throw new Error('不是普通文件')
      if (platform !== 'win32') fsApi.accessSync(executable, fs.constants.X_OK)
    } catch (error) {
      if (candidate.explicit) return mediaFailure(kind, candidate, error?.code === 'EACCES' ? '没有执行权限' : '文件不存在或不可执行', platform)
      continue
    }

    const actualPath = (() => { try { return fsApi.realpathSync(executable) } catch { return executable } })()
    const result = probe
      ? probe(actualPath, { kind, platform, env })
      : runToolProbe(actualPath, kind, { spawnSyncImpl, timeoutMs })
    if (!result?.ok) {
      if (candidate.explicit) return mediaFailure(kind, candidate, result?.reason || '命令启动失败', platform)
      continue
    }
    const capabilities = result.capabilities || capabilityProbe(actualPath, kind, { spawnSyncImpl, timeoutMs })
    return {
      ok: true,
      executable: actualPath,
      path: actualPath,
      version: String(result.version || ''),
      platform,
      arch: String(result.arch || binaryArch(actualPath, { platform, spawnSyncImpl })),
      source: candidate.source,
      capabilities,
    }
  }
  return mediaFailure(kind, null, '没有找到可执行且能返回版本信息的工具', platform)
}

function mediaFailure(kind, candidate, reason, platform = process.platform) {
  const name = kind === 'ffmpeg' ? 'FFmpeg' : 'FFprobe'
  const variable = kind === 'ffmpeg' ? 'FFMPEG' : 'FFPROBE_PATH'
  return {
    ok: false,
    executable: null,
    path: candidate?.path ?? null,
    version: null,
    platform,
    arch: 'unknown',
    source: candidate?.source ?? 'not-found',
    capabilities: {},
    code: candidate?.explicit ? 'MEDIA_RUNTIME_OVERRIDE_INVALID' : 'MEDIA_RUNTIME_NOT_FOUND',
    error: `${name} 不可用：${reason}${candidate?.path ? `（${candidate.path}）` : ''}`,
    hint: `安装 ${name}，或将 ${variable} 设置为可执行文件的完整路径；Finder 启动时也会检查 Homebrew 常见位置。`,
  }
}

export function resolveMediaRuntime(options = {}) {
  const ffmpeg = inspectTool('ffmpeg', options)
  const ffprobe = inspectTool('ffprobe', options)
  const missingCapabilities = []
  if (ffmpeg.ok && ffmpeg.capabilities.resample !== true) missingCapabilities.push('FFmpeg aresample filter')
  if (ffprobe.ok && ffprobe.capabilities.streamInspection !== true) missingCapabilities.push('FFprobe stream inspection')
  const failed = [ffmpeg, ffprobe].filter((tool) => !tool.ok)
  return {
    ok: failed.length === 0 && missingCapabilities.length === 0,
    ffmpegPath: ffmpeg.ok ? ffmpeg.executable : null,
    ffprobePath: ffprobe.ok ? ffprobe.executable : null,
    ffmpeg,
    ffprobe,
    ...(failed.length || missingCapabilities.length ? {
      code: failed[0]?.code || 'MEDIA_CAPABILITY_MISSING',
      error: [
        ...failed.map((tool) => tool.error),
        ...(missingCapabilities.length ? [`媒体运行时缺少能力：${missingCapabilities.join('、')}`] : []),
      ].join('；'),
      hint: [
        ...failed.map((tool) => tool.hint),
        ...(missingCapabilities.length ? ['安装支持音频重采样和流信息检查的 FFmpeg/FFprobe 构建后重试。'] : []),
      ].join(' '),
    } : {}),
  }
}

export function ffmpegPath() {
  return inspectTool('ffmpeg').executable
}

export function ffprobePath() {
  return inspectTool('ffprobe').executable
}

export function ffmpegInfo() {
  return inspectTool('ffmpeg')
}

export function ffprobeInfo() {
  return inspectTool('ffprobe')
}

export function requireFfmpeg() {
  const info = ffmpegInfo()
  if (info.ok) return info.executable
  const error = new Error(`${info.error}\n${info.hint}`)
  error.code = info.code
  error.hint = info.hint
  throw error
}
