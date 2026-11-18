#!/usr/bin/env node

import 'source-map-support/register.js';
import './punycode.cjs';

void (async (): Promise<void> => {
  // ⚠️ Don't add code before this!
  // This has to be imported before logger and other libraries which are instrumented.
  const otel = await import('./instrumentation/index.ts');
  otel.init();

  try {
    const logger = await import('./logger/index.ts');
    /* v8 ignore next -- not easily testable */
    process.on('unhandledRejection', (err) => {
      logger.logger.error({ err }, 'unhandledRejection');
      process.exitCode ??= 1;
    });
    await logger.init();

    (await import('./proxy.ts')).bootstrap();

    const { runRenovateCli } =
      await import('./workers/global/config/parse/cli.ts');

    process.exitCode = await runRenovateCli(async (config) => {
      const { start } = await import('./workers/global/index.ts');
      return otel.instrument('run', () => start(config));
    });
  } finally {
    await otel.shutdown();
  }

  /* v8 ignore if -- no test required */
  if (process.env.RENOVATE_X_HARD_EXIT) {
    process.exit(process.exitCode);
  }
})();
