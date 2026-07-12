// One binary WebSocket multiplexes snapshots (binary) and reliable messages (JSON) behind a
// 1-byte tag. Pure: TextEncoder/TextDecoder are ES2022 globals, no DOM.

export const NET_TAG = { snap: 1, rel: 2 } as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

function withTag(tag: number, body: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out.buffer;
}

export function frameSnap(buf: ArrayBuffer): ArrayBuffer {
  return withTag(NET_TAG.snap, new Uint8Array(buf));
}

export function frameRel(obj: unknown): ArrayBuffer {
  return withTag(NET_TAG.rel, enc.encode(JSON.stringify(obj)));
}

export type Unframed = { kind: "snap"; buf: ArrayBuffer } | { kind: "rel"; obj: unknown };

export function unframe(data: ArrayBuffer): Unframed {
  const bytes = new Uint8Array(data);
  const body = bytes.subarray(1);
  if (bytes[0] === NET_TAG.snap) {
    // copy so the returned ArrayBuffer isn't a view into the socket's larger buffer
    return { kind: "snap", buf: body.slice().buffer };
  }
  return { kind: "rel", obj: JSON.parse(dec.decode(body)) };
}
