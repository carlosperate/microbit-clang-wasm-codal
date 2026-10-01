// codal.json to CODAL's config header, by the rule of the native harness's CMake: the caller's
// settings in file order, then the target's defaults they did not set, and the SoftDevice when
// DEVICE_BLE is 1. Each value is written plainly, never with CMake's own quirks.

export const CONFIG_HEADER = 'codal/codal_extra_definitions.h';
const SOFTDEVICE = ' #define SOFTDEVICE_PRESENT    1';

/** A codal.json the build cannot follow: the message's first line says what to do, any more is detail. */
export class ConfigError extends Error {
  name = 'ConfigError';
}

/**
 * @param {string} text the caller's codal.json
 * @param {string} targetText the payload's target-locked.json
 * @param {object} target the one target this package has
 * @returns {{ header: string, softdevice: boolean }}
 */
export function configure(text, targetText, target) {
  const json = parse(text.replace(/^﻿/, ''));
  if (!(json instanceof Map)) throw new ConfigError('codal.json has to hold one JSON object, { ... }.');

  const unsupported = {
    application: 'every C++ file in the project is compiled, wherever it is',
    output_folder: 'where the hex goes is up to the editor running the build',
  };
  for (const [key, why] of Object.entries(unsupported)) {
    if (json.has(key)) throw new ConfigError(`codal.json sets "${key}", which this build cannot follow: ${why}. Remove "${key}" from codal.json.`);
  }
  if (json.has('target')) checkTarget(json.get('target'), target);

  const config = json.has('config') ? json.get('config') : new Map();
  if (!(config instanceof Map)) {
    throw new ConfigError('"config" in codal.json has to be an object of settings, such as { "MICROBIT_BLE_ENABLED": 1 }.');
  }
  const defaults = parse(targetText).get('config');
  const merged = new Map([...config, ...[...defaults].filter(([key]) => !config.has(key))]);

  // codal-microbit-v2's CMake compares DEVICE_BLE with "1" as text, and refuses this in its own words.
  const softdevice = merged.has('DEVICE_BLE') && plain(merged.get('DEVICE_BLE')) === '1';
  if (merged.has('SOFTDEVICE_PRESENT') && !softdevice) {
    throw new ConfigError('codal.json: Do not define SOFTDEVICE_PRESENT in your configuration, use DEVICE_BLE instead.');
  }

  const lines = [...merged].map(([key, value]) => ` #define ${key}\t ${plain(value)}\n`).join('');
  return { header: lines + (softdevice ? SOFTDEVICE : ''), softdevice };
}

function checkTarget(given, target) {
  const keys = Object.keys(target);
  const same =
    given instanceof Map && given.size === keys.length && keys.every((key) => given.get(key) === target[key]);
  if (same) return;
  throw new ConfigError(
    `codal.json's "target" asks for a CODAL this build does not have: it has only ${target.name} ${target.branch}, ` +
      `so remove "target" or set it to exactly that one.\n"target": ${JSON.stringify(target, null, 4)}`
  );
}

// A value's text in the header: a number as it was written, since `52.0` and `52` differ in C.
function plain(value) {
  if (value instanceof JsonNumber) return value.text;
  if (typeof value === 'string') return value;
  return JSON.stringify(toJs(value));
}

function toJs(value) {
  if (value instanceof JsonNumber) return Number(value.text);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, entry]) => [key, toJs(entry)]));
  return Array.isArray(value) ? value.map(toJs) : value;
}

class JsonNumber {
  constructor(text) {
    this.text = text;
  }
}

// JSON.parse would turn `52.0` into 52, so objects come back as Maps in file order, a repeated
// key keeping its last value, and numbers as their text.
function parse(text) {
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const LITERAL = /true|false|null/y;
  let at = 0;

  const fail = (expected) => {
    const line = text.slice(0, at).split('\n').length;
    const column = at - text.lastIndexOf('\n', at - 1);
    const found = at < text.length ? `found ${JSON.stringify(text[at])}` : 'the file ended';
    throw new ConfigError(`codal.json is not valid JSON at line ${line}, column ${column}: expected ${expected}, ${found}.`);
  };
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at])) at++;
  };
  const token = (pattern) => {
    pattern.lastIndex = at;
    const match = pattern.exec(text)?.[0];
    if (match !== undefined) at += match.length;
    return match;
  };
  const expect = (char) => {
    space();
    if (text[at] !== char) fail(`"${char}"`);
    at++;
  };

  const value = () => {
    space();
    if (text[at] === '{') return object();
    if (text[at] === '[') return array();
    const string = token(STRING);
    if (string !== undefined) return JSON.parse(string);
    const number = token(NUMBER);
    if (number !== undefined) return new JsonNumber(number);
    const literal = token(LITERAL);
    if (literal !== undefined) return JSON.parse(literal);
    return fail('a value');
  };
  // Calls `item` for each comma-separated item up to `close`, the opening bracket already read.
  const items = (close, item) => {
    at++;
    space();
    if (text[at] !== close) {
      do item();
      while (text[at] === ',' && ++at);
    }
    expect(close);
  };
  const object = () => {
    const entries = new Map();
    items('}', () => {
      space();
      const key = token(STRING);
      if (key === undefined) fail('a quoted name');
      expect(':');
      entries.set(JSON.parse(key), value());
      space();
    });
    return entries;
  };
  const array = () => {
    const list = [];
    items(']', () => {
      list.push(value());
      space();
    });
    return list;
  };

  const result = value();
  space();
  if (at < text.length) fail('the end of the file');
  return result;
}
