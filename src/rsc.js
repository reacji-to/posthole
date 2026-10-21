// React Server Components "flight" payloads, as LinkedIn's server-driven UI
// sends them: newline-separated rows "<hex id>:<json>", plus "<id>:T<hex len>,<text>"
// rows whose length is in UTF-8 bytes. References between rows look like
// "$L1a" (lazy element), "$Q1b" (Map), "$W" (Set), "$@" (promise) or "$1c".
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const looksLikeFlight = text => typeof text === 'string' && /^[0-9a-f]{1,6}:[IT"[{]/.test(text);

export function parseFlight(text) {
  const bytes = encoder.encode(text);
  const rows = new Map();
  let i = 0;
  while (i < bytes.length) {
    const colon = bytes.indexOf(58, i);
    if (colon < 0) break;
    const id = decoder.decode(bytes.subarray(i, colon));
    i = colon + 1;
    if (!/^[0-9a-f]{1,8}$/.test(id)) {
      // Out of step (truncated stream): skip to the next line.
      const nl = bytes.indexOf(10, i);
      i = nl < 0 ? bytes.length : nl + 1;
      continue;
    }
    if (bytes[i] === 84) {
      const comma = bytes.indexOf(44, i);
      const length = parseInt(decoder.decode(bytes.subarray(i + 1, comma)), 16);
      rows.set(id, { tag: 'T', value: decoder.decode(bytes.subarray(comma + 1, comma + 1 + length)) });
      i = comma + 1 + length;
      continue;
    }
    let nl = bytes.indexOf(10, i);
    if (nl < 0) nl = bytes.length;
    let line = decoder.decode(bytes.subarray(i, nl));
    i = nl + 1;
    let tag = '';
    const prefix = line.match(/^([A-Z]{1,2})(?=[[{"])/);
    if (prefix) { tag = prefix[1]; line = line.slice(tag.length); }
    try { rows.set(id, { tag, value: JSON.parse(line) }); } catch { rows.set(id, { tag: '?', value: line }); }
  }
  return rows;
}

export const isElement = node => Array.isArray(node) && node.length === 4 && node[0] === '$';

// The row a "$…" string points at, if any.
export function referenced(rows, value) {
  const match = typeof value === 'string' && value.match(/^\$[LQW@]?([0-9a-f]+)$/);
  return match && rows.has(match[1]) ? match[1] : null;
}

// "$f6:props:children:0" points inside another row (React dedupes repeated values this way).
// Element tuples ["$", type, key, props] are addressed by name.
export function resolvePath(rows, value) {
  const match = typeof value === 'string' && value.match(/^\$[LQW@]?([0-9a-f]+)((?::[^:]+)+)$/);
  if (!match || !rows.has(match[1])) return undefined;
  let node = rows.get(match[1]).value;
  for (const part of match[2].slice(1).split(':')) {
    if (isElement(node)) node = { type: node[1], key: node[2], props: node[3] }[part] ?? node[Number(part)];
    else if (node && typeof node === 'object') node = node[part];
    else return undefined;
    if (typeof node === 'string' && /^\$[LQW@]?[0-9a-f]+$/.test(node) && referenced(rows, node)) node = rows.get(referenced(rows, node)).value;
  }
  return node;
}

// Depth-first walk over every JSON node in every row (references not followed).
export function eachNode(rows, visit) {
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (visit(node) === false) return;
    if (Array.isArray(node)) node.forEach(walk);
    else Object.values(node).forEach(walk);
  };
  for (const { value } of rows.values()) walk(value);
}
