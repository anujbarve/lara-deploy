const tty = process.stdout.isTTY;
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

let verbose = false;
export const setVerbose = (v: boolean) => {
  verbose = v;
};

export const step = (msg: string) => console.log(`\n${paint(36, '→')} ${msg}`);
export const ok = (msg: string) => console.log(`${paint(32, '✓')} ${msg}`);
export const warn = (msg: string) => console.log(`${paint(33, '!')} ${msg}`);
export const fail = (msg: string) => console.log(`${paint(31, '✗')} ${msg}`);
export const debug = (msg: string) => {
  if (verbose) console.log(paint(90, `  ${msg.trim().split('\n').join('\n  ')}`));
};
export const title = () => console.log(`${paint(1, 'Laravel Deploy')}`);

/** An error with a human-friendly explanation; printed without a stack trace. */
export class DeployError extends Error {
  constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
  }
}

export function printError(err: unknown): void {
  console.error('');
  if (err instanceof DeployError) {
    console.error(`${paint(31, '✗')} ${err.message}`);
    for (const line of err.details) console.error(line ? `  ${line}` : '');
  } else {
    const e = err as Error;
    console.error(`${paint(31, '✗')} ${e?.message ?? String(err)}`);
    if (verbose && e?.stack) console.error(e.stack);
    else console.error('  Run again with --verbose for details.');
  }
}
