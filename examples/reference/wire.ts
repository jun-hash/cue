// Node-side transport helpers for host.ts, mcp.ts and the tests.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const CUE_DIR = join(homedir(), '.cue');

/** One socket per browser profile name, e.g. `chrome`. */
export function socketPath(name: string): string {
  return join(CUE_DIR, `${name}.sock`);
}

/** Splits a byte stream of newline-delimited JSON into messages. */
export function lines(onMessage: (message: any) => void): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk) => {
    const parts = (pending + chunk.toString()).split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) if (part.trim()) onMessage(JSON.parse(part));
  };
}

/** Native messaging frames: 4-byte little-endian length, then JSON. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function frames(onMessage: (message: any) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      onMessage(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
      buffer = buffer.subarray(4 + length);
    }
  };
}
