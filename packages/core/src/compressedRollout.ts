import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { pipeline, Transform, type Readable, type TransformCallback } from "node:stream";
// The namespace, never a named import: a named import of an export this Node.js lacks stops the whole module graph
// from loading, so every command would fail on Node.js 22.0 to 22.14, not only the reads that need zstd.
import * as zlib from "node:zlib";

/**
 * Codex compresses a rollout it has not written to for 7 days into `<rollout>.jsonl.zst`, one zstd frame, and gives
 * it the plain file's mtime (openai/codex `codex-rs/rollout/src/compression.rs`, every version since compression
 * shipped). It writes the compressed file before it removes the plain one, and restores a plain file before it
 * appends to a compressed rollout, so for a moment both can exist: the plain file wins, as it does in Codex.
 */
export const COMPRESSED_ROLLOUT_SUFFIX = ".zst";

/** Node.js decodes zstd from 22.15.0 and 23.8.0 (its zlib docs: `zlib.createZstdDecompress`, added v23.8.0, v22.15.0). */
export const ZSTD_NODE_VERSIONS = "Node.js 22.15 or later";

export function isCompressedRolloutPath(path: string): boolean {
  return path.endsWith(`.jsonl${COMPRESSED_ROLLOUT_SUFFIX}`);
}

type ZstdDecoderFactory = (options?: { params?: Record<number, number> }) => Transform;
const zstd = zlib as unknown as { createZstdDecompress?: ZstdDecoderFactory; constants: Record<string, number | undefined> };

/** Whether this Node.js can decode zstd. */
export function zstdDecodingAvailable(): boolean {
  return typeof zstd.createZstdDecompress === "function";
}

/** libzstd's own default window limit, 128 MiB, held here so the decoder's memory has a stated bound. Codex's level-3 frames use far less. */
const ZSTD_WINDOW_LOG_MAX = 27;
const ZSTD_MAGIC = 0xfd2fb528;

function frameError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Walks the compressed bytes on their way to the decoder: one zstd frame that ends where the file ends. Node.js decodes
 * only a file's first frame and ends quietly on a truncated one, so without this a cut or appended file would read as a
 * shorter session. Passes every byte through unchanged and reads nothing else.
 */
class SingleZstdFrame extends Transform {
  /** The frame's declared content size, once its header has passed. */
  contentSize: number | undefined;
  private phase: "header" | "blockHeader" | "blockBody" | "checksum" | "done" = "header";
  private gathered = Buffer.alloc(0);
  private remaining = 0;
  private lastBlock = false;
  private checksumBytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.walk(chunk);
    } catch (error) {
      done(error as Error);
      return;
    }
    done(null, chunk);
  }

  override _flush(done: TransformCallback): void {
    done(this.phase === "done" ? null : frameError("ZSTD_FRAME_INCOMPLETE"));
  }

  private gather(chunk: Buffer, at: number, need: number): number {
    const take = Math.min(need - this.gathered.length, chunk.length - at);
    this.gathered = Buffer.concat([this.gathered, chunk.subarray(at, at + take)]);
    return at + take;
  }

  private walk(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      if (this.phase === "done") throw frameError("ZSTD_FRAME_TRAILING_DATA");
      if (this.phase === "blockBody" || this.phase === "checksum") {
        const take = Math.min(this.remaining, chunk.length - at);
        at += take;
        this.remaining -= take;
        if (this.remaining === 0) this.afterBody();
        continue;
      }
      if (this.phase === "header") {
        const need = this.gathered.length < 5 ? 5 : frameHeaderLength(this.gathered);
        at = this.gather(chunk, at, need);
        if (this.gathered.length < need || need === 5) continue;
        this.contentSize = frameContentSize(this.gathered);
        this.checksumBytes = (this.gathered[4]! >> 2) & 1 ? 4 : 0;
        this.gathered = Buffer.alloc(0);
        this.phase = "blockHeader";
        continue;
      }
      at = this.gather(chunk, at, 3);
      if (this.gathered.length < 3) continue;
      const header = this.gathered[0]! | this.gathered[1]! << 8 | this.gathered[2]! << 16;
      this.gathered = Buffer.alloc(0);
      const type = (header >> 1) & 3;
      if (type === 3) throw frameError("ZSTD_FRAME_INVALID");
      this.lastBlock = (header & 1) === 1;
      // A run-length block carries one byte; a raw or compressed block carries its size.
      this.remaining = type === 1 ? 1 : header >>> 3;
      this.phase = "blockBody";
      if (this.remaining === 0) this.afterBody();
    }
  }

  private afterBody(): void {
    if (this.phase === "checksum" || this.lastBlock && this.checksumBytes === 0) {
      this.phase = "done";
      return;
    }
    if (this.lastBlock) {
      this.phase = "checksum";
      this.remaining = this.checksumBytes;
      return;
    }
    this.phase = "blockHeader";
  }
}

/** The whole frame header's length, known from its first five bytes. Anything but one zstd frame is refused. */
function frameHeaderLength(start: Buffer): number {
  if (start.readUInt32LE(0) !== ZSTD_MAGIC) throw frameError("ZSTD_FRAME_INVALID");
  const descriptor = start[4]!;
  if (descriptor & 0x08) throw frameError("ZSTD_FRAME_INVALID");
  const singleSegment = (descriptor >> 5) & 1;
  const contentSizeFlag = descriptor >> 6;
  const contentSizeBytes = contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag]!;
  return 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]! + contentSizeBytes;
}

function frameContentSize(header: Buffer): number | undefined {
  const descriptor = header[4]!;
  const singleSegment = (descriptor >> 5) & 1;
  const contentSizeFlag = descriptor >> 6;
  const at = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]!;
  if (contentSizeFlag === 0) return singleSegment ? header[at]! : undefined;
  if (contentSizeFlag === 1) return header.readUInt16LE(at) + 256;
  if (contentSizeFlag === 2) return header.readUInt32LE(at);
  const size = header.readBigUInt64LE(at);
  return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : Number.MAX_SAFE_INTEGER;
}

/** Ends in an error unless the decoder gave exactly the size the frame declared. */
class DeclaredSize extends Transform {
  private decoded = 0;
  constructor(private readonly frame: SingleZstdFrame) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.decoded += chunk.length;
    done(null, chunk);
  }

  override _flush(done: TransformCallback): void {
    const declared = this.frame.contentSize;
    done(declared === undefined || declared === this.decoded ? null : frameError("ZSTD_SIZE_MISMATCH"));
  }
}

/**
 * A transcript's bytes. A compressed rollout is decoded as it streams, with memory bounded by the decoder's window and
 * one line at a time downstream. A file that is not one complete frame, or does not decode to the size it declares,
 * ends in an error rather than a short read. Callers check `zstdDecodingAvailable()` first. An open handle is read
 * from its start and left open for its owner to close.
 */
export function openTranscriptBytes(file: string, handle?: FileHandle): Readable {
  const source = handle ? handle.createReadStream({ start: 0, autoClose: false }) : createReadStream(file);
  if (!isCompressedRolloutPath(file)) return source;
  const create = zstd.createZstdDecompress;
  const windowLogMax = zstd.constants.ZSTD_d_windowLogMax;
  if (typeof create !== "function" || windowLogMax === undefined) {
    source.destroy();
    throw frameError("ZSTD_UNSUPPORTED");
  }
  const frame = new SingleZstdFrame();
  const size = new DeclaredSize(frame);
  pipeline(source, frame, create({ params: { [windowLogMax]: ZSTD_WINDOW_LOG_MAX } }), size, () => undefined);
  return size;
}

/** The decoded size a compressed rollout declares in its frame header, or undefined when it declares none or is not one. */
export async function compressedContentSize(handle: FileHandle): Promise<number | undefined> {
  const header = Buffer.alloc(18);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  try {
    if (bytesRead < 5 || frameHeaderLength(header) > bytesRead) return undefined;
    return frameContentSize(header);
  } catch {
    return undefined;
  }
}

/** The same, decoded as UTF-8 text. A plain file reads exactly as it always has. */
export function openTranscriptText(file: string): Readable {
  if (!isCompressedRolloutPath(file)) return createReadStream(file, { encoding: "utf8" });
  return openTranscriptBytes(file).setEncoding("utf8");
}

/**
 * A whole transcript's decoded bytes, for the readers that read a whole plain file at once. `overLimit` is thrown as
 * soon as more than `maxBytes` have decoded.
 */
export async function readWholeTranscriptBytes(file: string, options: {
  handle?: FileHandle; maxBytes?: number; overLimit?: () => Error;
} = {}): Promise<Buffer> {
  const input = openTranscriptBytes(file, options.handle);
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      bytesRead += chunk.length;
      if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
        throw options.overLimit?.() ?? new RangeError("Transcript is larger than its limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    input.destroy();
  }
  return Buffer.concat(chunks, bytesRead);
}
