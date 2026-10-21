let lastMs = 0;
let counter = 0;

/** RFC 9562 UUIDv7 (time-ordered; monotonic within this process via a 12-bit counter). */
export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    counter++;
    if (counter > 0xfff) {
      lastMs++;
      counter = 0;
    }
  } else {
    lastMs = now;
    counter = 0;
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ms = lastMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
