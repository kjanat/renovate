import { cli, command, flag } from '@kjanat/dreamcli';
import { init, logger } from '../lib/logger/index.ts';
import { generateDocs } from './docs/index.ts';

await init();

process.on('unhandledRejection', (err) => {
  // Will print "unhandledRejection err is not defined"
  logger.error({ err }, 'unhandledRejection');
  process.exit(-1);
});

const generate = command('generate')
  .description('Generate docs')
  .flag('mkdocs', flag.boolean().describe('Generate docs for MkDocs'))
  .flag(
    'version',
    flag.string().describe('The current version of the Renovate CLI'),
  )
  .action(async ({ flags: opts }) => {
    if (opts.mkdocs) {
      logger.info('Generating for mkdocs');
      await generateDocs('tools/mkdocs', false, opts.version);
    } else {
      logger.info('Generating docs for testing');
      await generateDocs(undefined, undefined, opts.version);
    }
    logger.info('Generation completed');
  });

await cli('pnpm build:docs').default(generate).run();
