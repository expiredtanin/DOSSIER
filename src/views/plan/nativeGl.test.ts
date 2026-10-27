import { describe, expect, it } from 'vitest';
import { NativeGl, blockHashes, changedRanges } from './nativeGl';

const mk = (n: number, fill = 1) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + fill) & 255;
  return a;
};

describe('Änderungsvergleich', () => {
  it('findet nur geänderte, zusammengefasste Blöcke', () => {
    const a = mk(100_000);
    const b = a.slice();
    b[20_000] ^= 1; // Block 1
    b[36_000] ^= 1; // Block 2 (angrenzend)
    b[90_000] ^= 1; // Block 5
    const r = changedRanges(blockHashes(a), blockHashes(b), a.byteLength);
    expect(r).toEqual([[16384, 32768], [81920, 16384]]);
  });
  it('identische Daten → keine Bereiche', () => {
    const a = mk(50_000);
    expect(changedRanges(blockHashes(a), blockHashes(a.slice()), a.byteLength)).toEqual([]);
  });
});

describe('NativeGl: Patch statt Voll-Upload', () => {
  it('gleich grosser Ersatz eines freigegebenen Puffers geht als Patch', () => {
    const calls: { cmd: string; headers?: Record<string, string>; len: number }[] = [];
    const gl = new NativeGl(async (cmd, body, opts) => {
      calls.push({ cmd, headers: (opts as any)?.headers, len: (body as Uint8Array).byteLength });
      return true;
    });
    const upload = (bytes: Uint8Array) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
      return b;
    };
    const first = mk(200_000);
    const b1 = upload(first);
    gl.takeLayout([]);
    expect(calls.map((c) => c.cmd)).toEqual(['native2d_upload']);

    const second = first.slice();
    second[100_000] ^= 1;
    gl.deleteBuffer(b1);
    upload(second);
    gl.takeLayout([]);
    expect(calls[1].cmd).toBe('native2d_patch');
    expect(calls[1].len).toBeLessThan(40_000);
    expect(calls[1].headers!['x-from']).toBe('1');
    expect(calls[1].headers!['x-to']).toBe('2');
  });
  it('andere Grösse → Voll-Upload', () => {
    const cmds: string[] = [];
    const gl = new NativeGl(async (cmd) => (cmds.push(cmd), true));
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, mk(100_000), gl.STATIC_DRAW);
    gl.takeLayout([]);
    gl.deleteBuffer(b);
    const c = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, c);
    gl.bufferData(gl.ARRAY_BUFFER, mk(120_000), gl.STATIC_DRAW);
    gl.takeLayout([]);
    expect(cmds).toEqual(['native2d_upload', 'native2d_upload']);
  });
});
