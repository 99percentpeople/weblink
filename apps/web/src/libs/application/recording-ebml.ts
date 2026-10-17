export interface Element {
  id: number;
  size: number;
  sizeAt: number;
  width: number;
  dataAt: number;
  end: number;
}

export function element(
  bytes: Uint8Array,
  offset: number,
): Element | undefined {
  const vint = (at: number, identifier: boolean) => {
    if (at >= bytes.length) return;
    const first = bytes[at];
    if (!first) throw new Error("Invalid EBML integer");
    const width = Math.clz32(first) - 23;
    if (identifier && width > 4)
      throw new Error("Invalid EBML identifier");
    if (at + width > bytes.length) return;
    let value = BigInt(
      identifier ? first : first & (0xff >> width),
    );
    for (let index = 1; index < width; index++)
      value = value * 256n + BigInt(bytes[at + index]);
    if (
      !identifier &&
      value === (1n << BigInt(7 * width)) - 1n
    )
      return { value: Infinity, width };
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("EBML integer is too large");
    return { value: Number(value), width };
  };
  const id = vint(offset, true);
  if (!id) return;
  const sizeAt = offset + id.width;
  const size = vint(sizeAt, false);
  if (!size) return;
  const dataAt = sizeAt + size.width;
  return {
    id: id.value,
    size: size.value,
    sizeAt,
    width: size.width,
    dataAt,
    end: dataAt + size.value,
  };
}

export function sizeBytes(
  size: number,
  minimum: number,
): Uint8Array<ArrayBuffer> {
  let width = minimum;
  while (size >= 2 ** (7 * width) - 1) width++;
  const bytes = new Uint8Array(width);
  let value = BigInt(size);
  for (let index = width - 1; index >= 0; index--) {
    bytes[index] = Number(value & 255n);
    value >>= 8n;
  }
  bytes[0] |= 1 << (8 - width);
  return bytes;
}

export function join(
  ...parts: Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function unsigned(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  if (!Number.isSafeInteger(value))
    throw new Error("EBML integer is too large");
  return value;
}

export function uintBytes(
  value: number,
  width = 1,
): Uint8Array<ArrayBuffer> {
  while (value >= 2 ** (8 * width)) width++;
  const bytes = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index--) {
    bytes[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return bytes;
}

export function encode(
  id: number,
  ...parts: Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const data = join(...parts);
  return join(
    uintBytes(id),
    sizeBytes(data.length, 1),
    data,
  );
}
