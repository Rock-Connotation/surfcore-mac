import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, fail, identifier, normalizeEvent, requireThat, validateEvent } from './memory-v2-contract.js';

export function writeFully(fd, bytes, io = fs) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = io.writeSync(fd, bytes, offset, bytes.length - offset, null);
    requireThat(Number.isInteger(written) && written > 0 && written <= bytes.length - offset, 'MEMORY_SPOOL_SHORT_WRITE', 'The producer queue could not complete a write.', 'Keep this segment intact; inspect disk space and retry using a new segment after recovery.');
    offset += written;
  }
}
export function createSpool({ directory, producerId, segmentId = randomUUID(), context, io = fs }) {
  identifier(producerId); identifier(segmentId);
  const root = path.resolve(directory);
  io.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${digest([producerId, segmentId])}.jsonl`);
  let fd;
  try { fd = io.openSync(file, 'wx', 0o600); }
  catch { return { ...fail('MEMORY_SPOOL_SEGMENT_EXISTS', 'A producer segment must be exclusively created.', 'Open a new stable segment ID; never append to an unknown existing segment.'), file }; }
  let seq = 0, offset = 0, retired = false, sealed = false;
  return {
    ok: true, file, producerId, segmentId,
    append(raw) {
      if (sealed || retired) return fail('MEMORY_SPOOL_RETIRED', 'This producer segment no longer accepts writes.', 'Keep the original segment and start a new one.');
      try {
        const events = normalizeEvent({ ...raw, producerId, segmentId, producerSeq: seq + 1 }, context);
        events.forEach(validateEvent);
        const bytes = Buffer.from(events.map((event) => `${canonical(event)}\n`).join(''));
        const startOffset = offset;
        writeFully(fd, bytes, io);
        io.fsyncSync(fd);
        offset += bytes.length; seq++;
        return { ok: true, acceptance: 'queued_durable', sourceState: 'pending', selectionState: 'not_selected', indexState: 'pending', events, startOffset, nextOffset: offset };
      } catch (error) {
        retired = true;
        return { ...fail(error.code?.startsWith('MEMORY_') ? error.code : 'MEMORY_SPOOL_WRITE_FAILED', 'The producer segment was retired after an incomplete or unconfirmed write.', 'Preserve the segment, inspect its complete prefix, and check the original operation receipt; do not overwrite it.'), acceptance: 'rejected', sourceState: 'pending' };
      }
    },
    seal() {
      if (sealed) return retired ? fail('MEMORY_SPOOL_RETIRED', 'The sealed segment has an unconfirmed prefix.', 'Preserve it and inspect original receipts before replay.') : { ok: true, sealed: true, nextOffset: offset };
      sealed = true;
      try { io.fsyncSync(fd); io.closeSync(fd); return retired ? fail('MEMORY_SPOOL_RETIRED', 'The segment contains an unconfirmed write.', 'Preserve it and inspect original receipts before replay.') : { ok: true, sealed: true, nextOffset: offset }; }
      catch { retired = true; try { io.closeSync(fd); } catch {} return fail('MEMORY_SPOOL_SEAL_FAILED', 'The producer segment could not be sealed.', 'Preserve it and inspect disk permissions before creating another segment.'); }
    },
  };
}

export function readSpool({ file, offset = 0, maxEvents = 100, maxBytes = 1024 * 1024, io = fs }) {
  let fd;
  try {
    requireThat(Number.isSafeInteger(offset) && offset >= 0, 'MEMORY_SPOOL_OFFSET_INVALID', 'The spool offset must be a nonnegative byte position.');
    requireThat(Number.isInteger(maxEvents) && maxEvents >= 1 && maxEvents <= 100 && Number.isInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 1024 * 1024, 'MEMORY_SPOOL_LIMIT_INVALID', 'Read batches are limited to 100 events or 1 MiB.');
    fd = io.openSync(file, 'r');
    const size = io.fstatSync(fd).size;
    requireThat(offset <= size, 'MEMORY_SPOOL_OFFSET_AHEAD', 'The spool cursor exceeds the segment size.', 'Keep the segment and restore its matching cursor; do not reset the cursor automatically.');
    if (offset > 0) {
      const previous = Buffer.alloc(1); io.readSync(fd, previous, 0, 1, offset - 1);
      requireThat(previous[0] === 10, 'MEMORY_SPOOL_OFFSET_INVALID', 'The cursor is not on a complete line boundary.');
    }
    const bytes = Buffer.alloc(Math.min(maxBytes, size - offset));
    let read = 0;
    while (read < bytes.length) {
      const n = io.readSync(fd, bytes, read, bytes.length - read, offset + read);
      if (!n) break;
      read += n;
    }
    const events = [], positions = [];
    let end = 0;
    for (let start = 0; start < read && events.length < maxEvents;) {
      const newline = bytes.subarray(0, read).indexOf(10, start);
      if (newline < 0) break;
      const line = bytes.subarray(start, newline);
      let event;
      try { event = validateEvent(JSON.parse(line.toString('utf8'))); }
      catch { return { ...fail('MEMORY_SPOOL_BAD_LINE', 'A complete producer record is malformed or has a conflicting digest.', 'Preserve the original bytes and inspect the indicated offset. An explicit quarantine/skip decision is required.'), events: [], positions: [], startOffset: offset, nextOffset: offset, badOffset: offset + start }; }
      if (events.length) requireThat(event.producerId === events[0].producerId && event.segmentId === events[0].segmentId, 'MEMORY_SPOOL_IDENTITY_CONFLICT', 'A segment contains more than one producer identity.');
      events.push(event); positions.push({ start: offset + start, end: offset + newline + 1 });
      end = newline + 1; start = end;
    }
    requireThat(events.length > 0 || read < maxBytes || offset + read === size, 'MEMORY_SPOOL_RECORD_TOO_LARGE', 'A complete record cannot fit the bounded reader.', 'Preserve this segment and use records with at most 64 KiB of content and bounded metadata.');
    return { ok: true, events, positions, producerId: events[0]?.producerId ?? null, segmentId: events[0]?.segmentId ?? null, startOffset: offset, nextOffset: offset + end, incompleteTail: offset + end < size, segmentDigest: digest([events[0]?.producerId ?? null, events[0]?.segmentId ?? null]) };
  } catch (error) {
    return { ...fail(error.code?.startsWith('MEMORY_') ? error.code : 'MEMORY_SPOOL_READ_FAILED', error.code?.startsWith('MEMORY_') ? error.message : 'The producer segment cannot be read.'), events: [], positions: [], startOffset: offset, nextOffset: offset };
  } finally { if (fd !== undefined) try { io.closeSync(fd); } catch {} }
}
