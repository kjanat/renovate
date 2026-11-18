import { arg, cli, command, flag } from '@kjanat/dreamcli';
import { SemVer } from 'semver';
import { init, logger } from '../lib/logger/index.ts';
import { bake } from './utils/docker.ts';

await init();

const platform = flag.string().describe('Docker platforms to build');
const version = flag
  .custom((value) => new SemVer(String(value)))
  .describe('Version to use as tag');

const build = command('build')
  .description('Build Docker images')
  .flag('platform', platform)
  .flag('version', version)
  .flag(
    'tries',
    flag
      .number({ int: true, min: 0 })
      .default(0)
      .describe('Number of retries after failure'),
  )
  .flag(
    'delay',
    flag
      .duration()
      .default(30_000)
      .describe('Delay between build attempts (e.g. 30s)'),
  )
  .arg(
    'dockerArgs',
    arg
      .string()
      .variadic()
      .default([])
      .describe('Additional Docker Buildx arguments (place after --)'),
  )
  .action(async ({ flags: { delay, ...flags }, args }) => {
    logger.info('Building docker images ...');
    await bake('build', { ...flags, delayMs: delay, args: args.dockerArgs });
  });

const push = command('push')
  .description('Publish Docker images')
  .flag('platform', platform)
  .flag('version', version)
  .action(async ({ flags }) => {
    logger.info('Publishing docker images ...');
    await bake('push', flags);
  });

await cli('pnpm build:docker').command(build).command(push).run();
