/**
 * Spawn a command with extra environment variables.
 *
 * npm runs scripts through cmd on Windows, where `FOO=bar npm test` is not an
 * assignment but a command it cannot find, so the inline form that works on a
 * POSIX shell fails there. This does the same job from Node, which behaves the
 * same on both.
 *
 * A shell is needed so `npm` resolves to `npm.cmd` on Windows, and the command
 * goes to it as one already-quoted string. Passing an argument array alongside
 * `shell: true` concatenates them without escaping, which mangles anything
 * containing a space and is deprecated for that reason (DEP0190).
 *
 * Used by cheap-hashing.mjs and webhook-secrets.mjs; the per-script
 * documentation and warnings live in those, since they are what a reader
 * reaching for one of them needs.
 */

import { spawn } from 'node:child_process';

/** Quote an argument if the shell would otherwise split or interpret it. */
const quote = (arg) => (/[\s"'`^&|<>()%!]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/**
 * @param {Record<string, string>} extra  variables to add for the child only
 * @param {string[]} argv                 command and arguments
 * @param {{ usage: string, note?: string }} help
 */
export function runWithEnv(extra, argv, { usage, note }) {
  if (argv.length === 0) {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  if (note) console.warn(note);

  const child = spawn(argv.map(quote).join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extra },
  });

  child.on('error', (err) => {
    console.error(`could not run ${argv[0]}: ${err.message}`);
    process.exit(1);
  });

  // The command's own exit code is the whole point: npm scripts chain on it.
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
