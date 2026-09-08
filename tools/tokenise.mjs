// Splits one shell command line from `ninja -t commands` into an argv: POSIX word splitting minus
// what ninja never emits here, no expansion or redirection. Quoting is handled properly rather than
// pattern-matched, because a mangled flag becomes a wrong compile that still succeeds.

export function tokenise(line) {
  const argv = [];
  let current = '';
  let started = false;
  let quote = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '\\') {
      const next = line[i + 1];
      if (next === undefined) throw new Error(`trailing backslash: ${line}`);
      if (quote === "'") {
        current += ch; // literal inside single quotes, and it escapes nothing
      } else {
        // Outside quotes a backslash escapes anything; inside double quotes only these four.
        current += quote === '"' && !['"', '\\', '$', '`'].includes(next) ? ch + next : next;
        i++;
      }
      started = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }

    current += ch;
    started = true;
  }

  if (quote) throw new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote: ${line}`);
  if (started) argv.push(current);
  return argv;
}
