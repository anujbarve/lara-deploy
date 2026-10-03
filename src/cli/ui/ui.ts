/**
 * Terminal UI.
 *
 * Everything the user sees goes through this module, which is why no other
 * layer writes to stdout directly. It owns sections, status lines, spinners and
 * the summary block. `--json` mode swaps in a silent implementation so machine
 * output is never contaminated (SPEC §45, §54).
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';

export type Symbol = 'success' | 'failure' | 'warning' | 'action' | 'info' | 'pending';

export const SYMBOLS: Record<Symbol, string> = {
  success: '✓',
  failure: '✗',
  warning: '⚠',
  action: '→',
  info: '·',
  pending: '○',
};

export interface StatusLine {
  symbol: Symbol;
  message: string;
  /** Optional dim suffix, e.g. a command or duration. */
  detail?: string;
}

export interface DeployEvent {
  kind:
    | 'section'
    | 'status'
    | 'plain'
    | 'note'
    | 'warning'
    | 'error'
    | 'summary'
    | 'detail'
    | 'block'
    | 'command'
    | 'progress';
  text?: string;
  symbol?: Symbol;
  detail?: string;
  lines?: string[];
  /** 0..1 for progress events. */
  value?: number;
  /** Replace in place rather than append. */
  transient?: boolean;
}

/**
 * The interface the orchestrator and commands depend on.
 * Kept tiny so tests can capture every emitted event.
 */
export interface Ui {
  section(title: string): void;
  status(message: string, detail?: string): void;
  ok(message: string, detail?: string): void;
  fail(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
  action(message: string, detail?: string): void;
  info(message: string): void;
  note(message: string): void;
  detail(text: string): void;
  command(command: string, note?: string): void;
  /** Raw multi-line block, already formatted. */
  block(lines: string[]): void;
  /** Start/stop a spinner for a long operation. */
  startSpinner(text: string): void;
  updateSpinner(text: string): void;
  stopSpinner(result?: { ok: boolean; text?: string }): void;
  /** Show a warning with remediation steps. */
  advisory(message: string, remediation?: string[]): void;
  /** Final summary block. */
  summary(title: string, lines: string[]): void;
  /** True when output should be plain (non-interactive / --json). */
  readonly plain: boolean;
  /** Collect every event; used by tests and the JSON reporter. */
  readonly events: DeployEvent[];
}

/** Human-facing implementation. */
export class TerminalUi implements Ui {
  readonly events: DeployEvent[] = [];
  private spinner: Ora | null = null;
  private spinnerBase = '';
  private progressValue: number | null = null;
  private indent = 0;
  private quiet = false;

  constructor(private readonly options: { color?: boolean; quiet?: boolean } = {}) {
    if (options.color === false) chalk.level = 0;
    this.quiet = options.quiet ?? false;
  }

  get plain(): boolean {
    return false;
  }

  private emit(event: DeployEvent): void {
    this.events.push(event);
    if (this.quiet) return;

    // A spinner owns the line while it runs; clear it before printing.
    if (this.spinner && event.kind !== 'progress') this.clearSpinnerLine();

    switch (event.kind) {
      case 'section': {
        const title = chalk.bold.cyan(`◆ ${event.text}`);
        process.stdout.write(`\n${title}\n`);
        this.indent = 2;
        break;
      }
      case 'status': {
        const symbol = chalk.green(SYMBOLS[event.symbol ?? 'success']);
        const detail = event.detail ? chalk.dim(` ${event.detail}`) : '';
        process.stdout.write(`${' '.repeat(this.indent)}${symbol} ${event.text}${detail}\n`);
        break;
      }
      case 'plain': {
        process.stdout.write(`${' '.repeat(this.indent)}${event.text ?? ''}\n`);
        break;
      }
      case 'note': {
        process.stdout.write(`${' '.repeat(this.indent)}${chalk.dim(event.text ?? '')}\n`);
        break;
      }
      case 'detail': {
        process.stdout.write(`${' '.repeat(this.indent + 2)}${chalk.dim(event.text ?? '')}\n`);
        break;
      }
      case 'command': {
        process.stdout.write(
          `${' '.repeat(this.indent)}${chalk.yellow(SYMBOLS.action)} ${chalk.gray(event.text ?? '')}\n`,
        );
        break;
      }
      case 'warning': {
        process.stdout.write(`${' '.repeat(this.indent)}${chalk.yellow(SYMBOLS.warning)} ${event.text ?? ''}\n`);
        break;
      }
      case 'error': {
        process.stderr.write(`${' '.repeat(this.indent)}${chalk.red(SYMBOLS.failure)} ${event.text ?? ''}\n`);
        break;
      }
      case 'block': {
        for (const line of event.lines ?? []) {
          process.stdout.write(`${' '.repeat(this.indent)}${line}\n`);
        }
        break;
      }
      case 'summary': {
        const title = chalk.bold(event.text ?? 'Summary');
        process.stdout.write(`\n${title}\n${chalk.dim('─'.repeat(title.length))}\n`);
        for (const line of event.lines ?? []) {
          process.stdout.write(`  ${line}\n`);
        }
        break;
      }
      case 'progress': {
        // Handled by updateProgress; nothing to print.
        break;
      }
      default:
        break;
    }
  }

  private clearSpinnerLine(): void {
    if (this.spinner?.isSpinning) this.spinner.clear();
  }

  section(title: string): void {
    this.emit({ kind: 'section', text: title });
  }

  status(message: string, detail?: string): void {
    this.emit({ kind: 'status', symbol: 'success', text: message, ...(detail ? { detail } : {}) });
  }

  ok(message: string, detail?: string): void {
    this.emit({ kind: 'status', symbol: 'success', text: message, ...(detail ? { detail } : {}) });
  }

  fail(message: string, detail?: string): void {
    this.emit({ kind: 'error', text: message, ...(detail ? { detail } : {}) });
  }

  warn(message: string, detail?: string): void {
    this.emit({ kind: 'warning', text: message, ...(detail ? { detail } : {}) });
  }

  action(message: string, detail?: string): void {
    this.emit({ kind: 'status', symbol: 'action', text: message, ...(detail ? { detail } : {}) });
  }

  info(message: string): void {
    this.emit({ kind: 'note', text: message });
  }

  note(message: string): void {
    this.emit({ kind: 'note', text: message });
  }

  detail(text: string): void {
    this.emit({ kind: 'detail', text });
  }

  command(command: string, note?: string): void {
    this.emit({ kind: 'command', text: command, ...(note ? { detail: note } : {}) });
  }

  block(lines: string[]): void {
    this.emit({ kind: 'block', lines });
  }

  startSpinner(text: string): void {
    if (this.quiet) return;
    if (this.spinner) this.stopSpinner();
    this.spinnerBase = text;
    this.spinner = ora({ text, stream: process.stdout }).start();
    this.events.push({ kind: 'note', text });
  }

  updateSpinner(text: string): void {
    this.spinnerBase = text;
    if (this.spinner) this.spinner.text = this.renderSpinnerText(text);
    this.events.push({ kind: 'note', text });
  }

  updateProgress(value: number): void {
    this.progressValue = Math.max(0, Math.min(1, value));
    if (this.spinner) this.spinner.text = this.renderSpinnerText(this.spinnerBase);
    this.events.push({ kind: 'progress', value: this.progressValue });
  }

  /** ora has no progress bar, so the percentage is folded into the label. */
  private renderSpinnerText(text: string): string {
    if (this.progressValue === null) return text;
    return `${text} ${Math.round(this.progressValue * 100)}%`;
  }

  stopSpinner(result?: { ok: boolean; text?: string }): void {
    if (!this.spinner) return;
    this.progressValue = null;
    const text = result?.text ?? this.spinner.text;
    if (result?.ok === false) this.spinner.fail(text);
    else this.spinner.succeed(text);
    this.spinner = null;
  }

  advisory(message: string, remediation: string[] = []): void {
    this.emit({ kind: 'warning', text: message });
    for (const line of remediation) {
      this.emit({ kind: 'detail', text: `→ ${line}` });
    }
  }

  summary(title: string, lines: string[]): void {
    this.emit({ kind: 'summary', text: title, lines });
  }
}

/** Silent UI for `--json` and tests; every event is still recorded. */
export class SilentUi implements Ui {
  readonly events: DeployEvent[] = [];
  readonly plain = true;

  private record(event: DeployEvent): void {
    this.events.push(event);
  }

  section(title: string): void {
    this.record({ kind: 'section', text: title });
  }
  status(message: string, detail?: string): void {
    this.record({ kind: 'status', symbol: 'success', text: message, ...(detail ? { detail } : {}) });
  }
  ok(message: string, detail?: string): void {
    this.status(message, detail);
  }
  fail(message: string, detail?: string): void {
    this.record({ kind: 'error', text: message, ...(detail ? { detail } : {}) });
  }
  warn(message: string, detail?: string): void {
    this.record({ kind: 'warning', text: message, ...(detail ? { detail } : {}) });
  }
  action(message: string, detail?: string): void {
    this.record({ kind: 'status', symbol: 'action', text: message, ...(detail ? { detail } : {}) });
  }
  info(message: string): void {
    this.record({ kind: 'note', text: message });
  }
  note(message: string): void {
    this.record({ kind: 'note', text: message });
  }
  detail(text: string): void {
    this.record({ kind: 'detail', text });
  }
  command(command: string, note?: string): void {
    this.record({ kind: 'command', text: command, ...(note ? { detail: note } : {}) });
  }
  block(lines: string[]): void {
    this.record({ kind: 'block', lines });
  }
  startSpinner(text: string): void {
    this.record({ kind: 'note', text });
  }
  updateSpinner(text: string): void {
    this.record({ kind: 'note', text });
  }
  updateProgress(value: number): void {
    this.record({ kind: 'progress', value });
  }
  stopSpinner(): void {
    /* no-op */
  }
  advisory(message: string, remediation: string[] = []): void {
    this.record({ kind: 'warning', text: message });
    for (const line of remediation) this.record({ kind: 'detail', text: `→ ${line}` });
  }
  summary(title: string, lines: string[]): void {
    this.record({ kind: 'summary', text: title, lines });
  }
}

/** Render a list of health/doctor checks. */
export function renderChecks(
  ui: Ui,
  title: string,
  results: ReadonlyArray<{ name: string; status: string; message: string; remediation?: string[] }>,
  overall?: string,
): void {
  ui.section(title);
  for (const result of results) {
    switch (result.status) {
      case 'pass':
        ui.ok(capitalise(result.name), result.message);
        break;
      case 'warn':
        ui.warn(capitalise(result.name), result.message);
        break;
      case 'fail':
        ui.fail(capitalise(result.name), result.message);
        break;
      default:
        ui.info(`${capitalise(result.name)} — skipped`);
        break;
    }
    if (result.status !== 'pass' && result.remediation) {
      for (const line of result.remediation) ui.detail(line);
    }
  }
  if (overall) {
    ui.section('Overall');
    if (overall === 'HEALTHY') ui.ok(`Overall: ${overall}`);
    else if (overall === 'DEGRADED') ui.warn(`Overall: ${overall}`);
    else ui.fail(`Overall: ${overall}`);
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ');
}