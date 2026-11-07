import fs from 'node:fs';
import { fail } from './errors.js';

export const DEFAULT_RESOURCE_LIMITS = Object.freeze({ maxAssetBytes: 2 * 1024 ** 3, maxDurationMs: 6 * 60 * 60 * 1000, maxQueuedConsumers: 32, reserveBytes: 512 * 1024 ** 2 });
export function resourceLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ASR_LIMITS_INVALID','The ASR resource limits are invalid.','Provide positive integer resource limits.',{stage:'initialize'});
  const result={...DEFAULT_RESOURCE_LIMITS};
  for (const key of Object.keys(result)) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw fail('ASR_LIMITS_INVALID','An ASR resource limit is invalid.',`Provide ${key} as a positive safe integer.`,{stage:'initialize'});
    result[key]=input[key];
  }
  return result;
}
export function checkDuration(durationMs, limits) {
  if (durationMs > limits.maxDurationMs) throw fail('ASR_DURATION_LIMIT','The audio exceeds the local ASR duration limit.','Split the audio into shorter registered assets or adjust the local duration limit before retrying.',{stage:'resources'});
}
export function checkAssetSize(size, limits) {
  if (size > limits.maxAssetBytes) throw fail('ASR_ASSET_SIZE_LIMIT','The audio asset exceeds the local ASR size limit.','Split or compress the asset, or adjust the local size limit before retrying.',{stage:'resources'});
}
export async function checkDiskSpace(directory, durationMs, chunks, limits, statfs = fs.promises.statfs) {
  // 16 kHz mono s16le: 32 bytes/ms. Chunk WAVs remain alongside normalized WAV.
  const bytesPerMs=32n, normalized=BigInt(durationMs)*bytesPerMs;
  const chunkBytes=chunks.reduce((sum,chunk)=>sum+BigInt(chunk.durationMs)*bytesPerMs+1048576n,0n);
  const needed=BigInt(limits.reserveBytes)+normalized+chunkBytes;
  let available;
  try {
    const info=await statfs(directory,{bigint:true});
    if (info?.bavail == null || info?.bsize == null) throw new Error('missing statfs fields');
    available=BigInt(info.bavail)*BigInt(info.bsize);
    if (available < 0n || BigInt(info.bsize) <= 0n) throw new Error('invalid statfs fields');
  } catch (error) {
    throw fail('ASR_DISK_SPACE_UNKNOWN','The available disk space could not be checked.','Check access to the ASR data directory and available disk space, then retry.',{retryable:true,stage:'resources',cause:error});
  }
  if (available < needed) throw fail('ASR_DISK_SPACE_LOW','There is not enough available space to normalize and process this audio.','Free disk space or select a shorter audio asset, then resume the job.',{retryable:true,stage:'resources'});
}
