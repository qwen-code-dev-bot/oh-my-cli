// Streaming UTF-8 reassembly for raw terminal input (Issue #731). The shell
// receives stdin as arbitrary chunks; a multi-byte character delivered across
// chunk boundaries (remote/latency-split input, incremental IME commits,
// scripted delivery) must be reassembled before dispatch. Without this, a
// lone byte ≥ 0x80 is dropped by the single-byte branch and an incomplete
// trailing sequence decodes to U+FFFD mojibake in the composer. Pure and
// stateless: the caller threads `pending` through successive chunks.

export interface Utf8StreamDecode {
  // Decoded text of the complete prefix. Invalid bytes are dropped — never
  // emitted as U+FFFD — so malformed input cannot inject replacement
  // characters into prompts (which flow to providers and transcripts).
  text: string;
  // A trailing incomplete sequence (1–3 bytes) to prepend to the next chunk.
  pending: Buffer;
}

// Fast path guard: pure-ASCII chunks (single keys, escape sequences — the
// overwhelming common case) skip reassembly entirely.
export function hasNonAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) return true;
  }
  return false;
}

// Expected byte length of a UTF-8 lead byte; 0 for continuation bytes,
// overlong leads (C0/C1), and out-of-range leads (F5–FF) — all invalid.
function leadLength(b: number): number {
  if (b >= 0xf0 && b <= 0xf4) return 4;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xc2 && b <= 0xdf) return 2;
  return 0;
}

export function decodeUtf8Streaming(pending: Buffer, chunk: Buffer): Utf8StreamDecode {
  const buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;

  // Detect a trailing incomplete sequence: scan at most the last three bytes
  // backwards for a lead whose expected length exceeds the bytes following
  // it. ASCII terminates any sequence; an invalid lead is never held (it can
  // never complete, so it is left for decode to drop).
  let hold = 0;
  for (let i = 1; i <= Math.min(3, buf.length); i++) {
    const b = buf[buf.length - i];
    if (b < 0x80) break;
    const need = leadLength(b);
    if (need > 0) {
      if (i < need) hold = i;
      break;
    }
    // Continuation byte: keep scanning backwards for its lead.
  }

  const head = hold > 0 ? buf.subarray(0, buf.length - hold) : buf;
  const rest = hold > 0 ? Buffer.from(buf.subarray(buf.length - hold)) : Buffer.alloc(0);
  return { text: decodeDroppingInvalid(head), pending: rest };
}

function decodeDroppingInvalid(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    const need = leadLength(b);
    if (need === 0 || i + need > buf.length) {
      // Invalid lead (or a truncated cluster at this boundary): drop the
      // byte and rescan — continuation bytes are themselves invalid.
      i += 1;
      continue;
    }
    let ok = true;
    for (let k = 1; k < need; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      // Broken cluster: drop the lead; the followers rescan as invalid.
      i += 1;
      continue;
    }
    out += buf.toString("utf-8", i, i + need);
    i += need;
  }
  return out;
}
