#!/usr/bin/env node
/**
 * Executable entry point (`laravel-deploy`).
 */

import { main } from './program.js';

void main().catch((error: unknown) => {
  process.stderr.write(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});