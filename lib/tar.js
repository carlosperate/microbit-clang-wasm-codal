// A minimal ustar reader and writer, so the CODAL payload travels as one asset: a host that cannot
// read a directory would otherwise fetch a thousand headers one at a time. Hand-rolled because
// nanotar, already in the tree, writes only the 100-byte name field — too short for CODAL's paths.

const BLOCK = 512;
const NAME = 100;
const PREFIX = 155;

/** @param {Record<string, Uint8Array>} entries paths to contents @returns {Uint8Array} */
export function packTar(entries) {
  const names = Object.keys(entries).sort();
  const blocks = names.reduce((total, name) => total + 1 + Math.ceil(entries[name].length / BLOCK), 2);

  const out = new Uint8Array(blocks * BLOCK);
  let at = 0;
  for (const name of names) {
    out.set(header(name, entries[name].length), at);
    at += BLOCK;
    out.set(entries[name], at);
    at += Math.ceil(entries[name].length / BLOCK) * BLOCK;
  }
  return out; // the two zero blocks that end the archive are already zero
}

/** @param {Uint8Array} tar @returns {object} a tree of nested objects with Uint8Array leaves */
export function unpackTar(tar) {
  const tree = Object.create(null);
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    verifyChecksum(block, at);

    const name = text(block, 0, NAME);
    const prefix = text(block, 345, PREFIX);
    const size = parseInt(text(block, 124, 12) || '0', 8);
    const type = String.fromCharCode(block[156]);
    // A size the archive cannot hold means truncation or corruption; a negative one would walk
    // backwards for ever.
    if (!Number.isSafeInteger(size) || size < 0 || at + BLOCK + size > tar.length) {
      throw new Error(`tar entry at ${at} declares ${size} bytes, which the archive does not hold`);
    }
    at += BLOCK;

    const full = prefix ? `${prefix}/${name}` : name;
    if (type === '0' || type === '\0') {
      // A view, not a copy: these become the session's files, so copying would duplicate 25 MB.
      insert(tree, full, tar.subarray(at, at + size));
    } else if (type !== '5') {
      throw new Error(`unsupported tar entry type '${type}' for ${full}`);
    }
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return tree;
}

/** @param {object} tree @returns {Record<string, Uint8Array>} flat paths, for packTar */
export function flatten(tree, base = '') {
  const out = {};
  for (const [key, value] of Object.entries(tree)) {
    const full = base ? `${base}/${key}` : key;
    if (value instanceof Uint8Array) out[full] = value;
    else Object.assign(out, flatten(value, full));
  }
  return out;
}

function header(name, size) {
  const block = new Uint8Array(BLOCK);
  const [prefix, base] = split(name);

  write(block, base, 0, NAME);
  write(block, '000644 ', 100, 8);
  write(block, '000000 ', 108, 8);
  write(block, '000000 ', 116, 8);
  write(block, size.toString(8).padStart(11, '0') + ' ', 124, 12);
  write(block, '00000000000 ', 136, 12); // mtime 0: the archive has to be reproducible
  write(block, '        ', 148, 8); // checksum field counts as spaces while summing
  block[156] = '0'.charCodeAt(0);
  write(block, 'ustar', 257, 6);
  write(block, '00', 263, 2);
  write(block, prefix, 345, PREFIX);

  const sum = block.reduce((total, byte) => total + byte, 0);
  write(block, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

// ustar splits a long path into a 155-byte prefix and a 100-byte name, at a slash.
function split(name) {
  if (name.length <= NAME) return ['', name];
  for (let at = name.length - NAME - 1; at < name.length; at++) {
    if (name[at] === '/' && name.length - at - 1 <= NAME && at <= PREFIX) {
      return [name.slice(0, at), name.slice(at + 1)];
    }
  }
  throw new Error(`path too long for a ustar header: ${name}`);
}

// The header sums its own bytes with the checksum field read as spaces; a mismatch means the block
// is not a header at all, so stopping here beats reading garbage sizes off it.
function verifyChecksum(block, at) {
  const stored = parseInt(text(block, 148, 8), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (sum !== stored) throw new Error(`tar header at ${at} fails its checksum; the archive is corrupt or misaligned`);
}

function write(block, value, offset, length) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error(`field too long for a ustar header: ${value}`);
  block.set(bytes, offset);
}

function text(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end)).trim();
}

// Directories are prototype-free: an archive holding `__proto__/x` would otherwise walk into
// Object.prototype and write there instead.
function insert(tree, name, data) {
  const parts = name.split('/');
  let node = tree;
  for (const part of parts.slice(0, -1)) node = node[part] ??= Object.create(null);
  node[parts[parts.length - 1]] = data;
}
