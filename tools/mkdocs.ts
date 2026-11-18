import { cli, command, flag } from '@kjanat/dreamcli';
import type { Result, ResultPromise } from 'execa';
import { execa } from 'execa';
import fs from 'fs-extra';
import { init, logger } from '../lib/logger/index.ts';
import { generateDocs } from './docs/index.ts';
import { exec } from './utils/exec.ts';

await init();

process.on('unhandledRejection', (err) => {
  // Will print "unhandledRejection err is not defined"
  logger.error({ err }, 'unhandledRejection');
  process.exit(-1);
});

const buildDocs = flag
  .boolean()
  .negatable()
  .default(true)
  .describe('Build docs from source');
const strict = flag
  .boolean()
  .negatable()
  .default(true)
  .describe('Run in strict mode');

const build = command('build')
  .description('Build mkdocs')
  .flag(
    'version',
    flag.string().describe('The current version of the Renovate CLI'),
  )
  .flag('build', buildDocs)
  .flag('strict', strict)
  .flag(
    'announcement',
    flag
      .boolean()
      .negatable()
      .default(true)
      .describe('Include the announcement bar'),
  )
  .action(async ({ flags: opts }) => {
    await prepareDocs(opts);
    if (opts.announcement) {
      logger.info('* running mkdocs build');
    } else {
      logger.info('* running mkdocs build (without announcement bar)');
    }
    const args = ['run', 'mkdocs', 'build'];
    if (opts.strict) {
      args.push('--strict');
    }
    const res = await exec('uv', args, {
      cwd: 'tools/mkdocs',
      stdio: 'inherit',
      env: {
        ...process.env,
        RENOVATE_VERSION: opts.version ?? '',
        MKDOCS_INCLUDE_ANNOUNCEMENT: opts.announcement ? 'true' : '',
      },
      reject: false,
    });
    checkResult(res);
  });

const serve = command('serve')
  .description('serve mkdocs')
  .flag('build', buildDocs)
  .flag('strict', strict)
  .action(async ({ flags: opts }) => {
    logger.info('serving docs');
    const mkdocsArgs = ['run', 'mkdocs', 'serve'];
    if (opts.strict) {
      mkdocsArgs.push('--strict');
    }
    function spawnServe(): ResultPromise {
      return execa('uv', mkdocsArgs, {
        cwd: 'tools/mkdocs',
        stdio: 'inherit',
        reject: false,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf8',
      });
    }

    if (!opts.build) {
      await prepareDocs(opts);
      checkResult(await spawnServe());
      return;
    }

    let activeChild: ResultPromise | null = null;
    let shouldRestart = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    fs.watch('docs', { recursive: true }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.info('docs changed, restarting mkdocs...');
        shouldRestart = true;
        activeChild?.kill();
      }, 300);
    });

    while (true) {
      shouldRestart = false;
      await prepareDocs(opts);
      logger.info('* running mkdocs serve');
      activeChild = spawnServe();
      const res = await activeChild;
      if (!shouldRestart) {
        checkResult(res);
        break;
      }
    }
  });

async function prepareDocs(opts: {
  build: boolean;
  version?: string | undefined;
}): Promise<void> {
  logger.info('Building docs');
  if (opts.build) {
    logger.info('* generate docs');
    await generateDocs('tools/mkdocs', false, opts.version);
  } else {
    logger.info('* using prebuild docs from build step');
    await fs.copy('tmp/docs', 'tools/mkdocs/docs');
  }
}

function checkResult(
  res: Pick<
    Result,
    'signal' | 'exitCode' | 'timedOut' | 'isTerminated' | 'failed'
  >,
): void {
  if (res.signal) {
    logger.error(`Signal received: ${res.signal}`);
    process.exit(-1);
  } else if (res.exitCode) {
    logger.error('Error occured');
    process.exit(res.exitCode);
  } else if (res.timedOut) {
    logger.error({ res }, 'Process timed out');
    process.exit(-1);
  } else if (res.isTerminated) {
    logger.error({ res }, 'Process was killed');
    process.exit(-1);
  } else if (res.failed) {
    logger.error({ res }, 'Process call failed');
    process.exit(-1);
  } else {
    logger.debug('Build completed');
  }
}

await cli('pnpm mkdocs')
  .description('Run mkdocs')
  .default(build, { route: true })
  .command(serve)
  .run();
