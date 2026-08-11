// Byte-capped streaming UTF-8 decoding for subprocess output (Issue #836).
//
// The hook/tool/MCP output caps previously decoded each stream chunk with a
// standalone `chunk.toString("utf8")`. A multi-byte UTF-8 character split across
// two chunks (the norm at every chunk boundary for continuous non-ASCII output)
// decodes as two U+FFFD replacement characters instead of the original character,
// silently corrupting captured output. Node's `StringDecoder` buffers a trailing
// incomplete sequence and reassembles it with the next chunk, so characters that
// straddle a chunk boundary survive intact. The decoder preserves the existing
// invalid-byte behavior of `Buffer.toString` (emit U+FFFD), unlike the composer's
// drop-invalid `decodeUtf8Streaming` (utf8-chunks.ts), which exists to keep
// replacement characters out of prompts.
//
// The byte cap (Issue #834) is applied to the reassembled text via
// `safeByteCutEnd`, and the cut never splits a UTF-16 surrogate pair
// (Issues #830/#832). The hook and tool caps bound the *combined* stdout+stderr,
// so both per-stream decoders thread one shared `OutputByteCapState`.

import { StringDecoder } from "node:string_decoder";
import { safeByteCutEnd } from "./text-cut.js";

// Shared byte-cap state across the output streams of one subprocess.
export interface OutputByteCapState {
  // UTF-8 bytes accumulated into emitted output so far.
  total: number;
  // True once the cap has been reached; decoders then return "".
  capped: boolean;
}

/**
 * Create a streaming UTF-8 decoder for a single output stream that honors a
 * shared byte cap. Returns a function that consumes a raw chunk and returns the
 * text to append to that stream's output ("" once the cap is reached or a chunk
 * contributes no complete character). When the cap is reached the returned text
 * is cut to the remaining byte budget without splitting a surrogate pair, and the
 * shared state is marked capped.
 */
export function createCappedUtf8Decoder(
  state: OutputByteCapState,
  maxBytes: number,
): (chunk: Buffer) => string {
  const decoder = new StringDecoder("utf8");
  return (chunk: Buffer): string => {
    if (state.capped) return "";
    const text = decoder.write(chunk);
    if (text === "") return "";
    const textBytes = Buffer.byteLength(text, "utf8");
    if (state.total + textBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - state.total);
      const cut = safeByteCutEnd(text, remaining);
      state.total = maxBytes;
      state.capped = true;
      return text.slice(0, cut);
    }
    state.total += textBytes;
    return text;
  };
}
