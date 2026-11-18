// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
// UNC 的主机/共享名之间只有一个反斜杠；JSON 键名可能带引号。
// 这是内容审计的启发式规则，不能代替会话权限控制或对已知令牌的精确拦截。
//
// 两道内容闸门是**有意互补**的，不是重复实现：
//   ① 这里（启发式）：抓"长得像路径 / 像凭据赋值"的文本，任何一条出站文本都能过；
//   ② KNOWN_AGENT_TOKENS 精确名单（bridge.js）：抓**已知的**会话令牌原文，
//      覆盖 onebotSend / redactKnownTokensOnly 这类刻意不跑 SENSITIVE_RE 的发送路径。
// 为什么第二条不可省：32 位十六进制的裸会话令牌**不匹配**下面的正则（它既不是路径，
// 也没有 token= 这种赋值形态），只有精确名单能拦住它。
// 反过来，**不要**为了让这条正则"顺带"覆盖裸 32-hex 而往里加 [0-9a-f]{32}：
// 表情 md5、图片 URL、消息里的十六进制串本身就是 32-hex，加进去会把正常的表情包与消息
// 整条拦掉/打码（误伤面远大于收益）。要收紧令牌泄漏，请走精确名单那条路。
import fs from 'node:fs';
import os from 'node:os';

const SENSITIVE_PATH_SRC = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*`;
const CREDENTIAL_ASSIGNMENT_SRC = String.raw`(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,})`;

export const SENSITIVE_RE = new RegExp(`(${SENSITIVE_PATH_SRC}|${CREDENTIAL_ASSIGNMENT_SRC})`, 'i');
const TASK_CREDENTIAL_RE = new RegExp(CREDENTIAL_ASSIGNMENT_SRC, 'i');
const TASK_PATH_EXTRACT_RE = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'`<>|]+|\\\\[^\\\s"'`<>|]+\\[^\s"'`<>|]+|(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/|\/tmp\/|\/private\/|\/System\/|\/Library\/)[^\s"'`<>|]*)/gi;
const UNSAFE_TASK_SYS_DIR_RE = /^\/(?:etc|root|proc|dev|sys|System|Library\/Keychains|private\/etc)(?:\/|$)/i;
const UNSAFE_TASK_VAR_DIR_RE = /^\/(?:private\/)?var(?:\/|$)/i;
const UNSAFE_TASK_WIN_DIR_RE = /^[A-Za-z]:\/(?:Windows|ProgramData|Users\/[^/]+\/AppData)(?:\/|$)/i;
const UNSAFE_TASK_MAC_LIB_RE = /(?:^|\/)Library\/(?:Keychains|Cookies|Application Support\/Google\/Chrome|Application Support\/Microsoft Edge)(?:\/|$)/i;
const UNSAFE_TASK_DOT_PATH_RE = /\/(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.env(?:\.[^/]*)?)(?:\/|$)/i;
const UNSAFE_TASK_DSH_DIR_RE = /\/\.dsh\/(?:profiles|storages|state|logs|memory-v2)(?:\/|$)/i;
const UNSAFE_TASK_FILE_RE = /(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|authorized_keys|known_hosts|console-token(?:\.txt)?|launch-token(?:\.txt)?|cookies(?:\.sqlite)?|login data|web data|local state|wallet(?:\.[a-z0-9]+)?|credentials?(?:\.[a-z0-9]+)?|config\.json|bili\.config\.json|qq\.config\.json|secrets?\.[a-z0-9]+)$/i;
const UNSAFE_TASK_EXT_RE = /\.(?:pem|key|p12|pfx|kdbx|sqlite3?|db)$/i;

function normalizePosix(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function safeRealpathPosix(value) {
  try { return normalizePosix(fs.realpathSync(String(value))); } catch { return ''; }
}

function isUnderDir(target, baseDir) {
  const normBase = normalizePosix(baseDir);
  if (normBase && (target === normBase || target.startsWith(normBase + '/'))) return true;
  const realBase = safeRealpathPosix(baseDir);
  return Boolean(realBase) && (target === realBase || target.startsWith(realBase + '/'));
}

/**
 * 判断本机任务摘要/附图里的路径是否指向系统敏感目录或凭据文件。
 * 允许默认任务工作区与桌面等常规产出路径，但拦截秘钥、环境配置及 DSH 内部状态目录。
 */
export function isUnsafeTaskFilePath(filePath, { allowTempDir = false, tmpDir = os.tmpdir() } = {}) {
  const raw = String(filePath ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return true;
  const normalized = normalizePosix(raw);
  if (!normalized || normalized.startsWith('//') || /(?:^|\/)\.\.(?:\/|$)/.test(normalized)) return true;
  if (UNSAFE_TASK_DOT_PATH_RE.test(normalized) || UNSAFE_TASK_DSH_DIR_RE.test(normalized) || UNSAFE_TASK_MAC_LIB_RE.test(normalized)) return true;
  if (UNSAFE_TASK_FILE_RE.test(normalized) || UNSAFE_TASK_EXT_RE.test(normalized)) return true;
  if (UNSAFE_TASK_SYS_DIR_RE.test(normalized) || UNSAFE_TASK_WIN_DIR_RE.test(normalized)) return true;
  if (UNSAFE_TASK_VAR_DIR_RE.test(normalized)) {
    const inTemp = allowTempDir && (isUnderDir(normalized, tmpDir) || isUnderDir(normalized, '/tmp') || isUnderDir(normalized, '/private/tmp'));
    if (!inTemp) return true;
  }
  return false;
}

/**
 * 审计本机任务回传文本：仍拦截显式 Secret、凭据赋值和敏感系统/密钥路径，
 * 仅对工作区/桌面等普通报告路径放行，避免误杀截图与文档结果摘要。
 */
export function hasSensitiveTaskOutput(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (new RegExp(SECRET_TOKEN_RE.source, SECRET_TOKEN_RE.flags.replace('g', '')).test(text)) return true;
  if (TASK_CREDENTIAL_RE.test(text)) return true;
  if (UNSAFE_TASK_MAC_LIB_RE.test(text.replace(/\\/g, '/'))) return true;
  for (const m of text.matchAll(/[`"']([^`"'\n\r<>|]+)[`"']/g)) {
    const inner = m[1].trim();
    if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(inner) && isUnsafeTaskFilePath(inner, { allowTempDir: true })) return true;
  }
  const matches = text.match(TASK_PATH_EXTRACT_RE) ?? [];
  for (const rawMatch of matches) {
    const cleaned = rawMatch.replace(/[，。；、！？）】》"'.,;:)\]]+$/, '');
    if (cleaned && isUnsafeTaskFilePath(cleaned, { allowTempDir: true })) return true;
  }
  return false;
}

/**
 * 明确的密钥形态（2026-11-01 用户反馈：PAT 被贴进 QQ 后原样落进 bridge.log）。
 * 这些前缀足够独特，误伤面小；用于**所有日志/活动/出站**前的打码，不代替 SENSITIVE_RE。
 */
export const SECRET_TOKEN_RE = /(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+\/-]{20,})/g;
