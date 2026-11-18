import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { SemVer } from 'semver';
import { logger } from '../../lib/logger/index.ts';
import { commandError, exec } from './exec.ts';

const file = 'tools/docker/bake.hcl';
const tmp = fs.mkdtemp(path.join(os.tmpdir(), 'renovate-docker-bake-'));

export class DockerBakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerBakeError';
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface MetaDataItem {
  'containerimage.digest'?: string;
}
export interface MetaData {
  'push-slim'?: MetaDataItem;
  'push-full'?: MetaDataItem;
}

export async function bake(
  target: string,
  opts: {
    platform?: string;
    version?: SemVer;
    args?: string[];
    delayMs?: number;
    tries?: number;
    channel?: string | false;
  },
): Promise<MetaData> {
  if (opts.version) {
    console.log(`Using version: ${opts.version.version}`);
    process.env.RENOVATE_VERSION = opts.version.version;
    if (!opts.version.prerelease.length) {
      process.env.RENOVATE_MAJOR_VERSION = `${opts.version.major}`;
      process.env.RENOVATE_MAJOR_MINOR_VERSION = `${opts.version.major}.${opts.version.minor}`;
    }
  }

  if (opts.channel) {
    process.env.CHANNEL = opts.channel.replace('maint/', '');
  }

  const metadataFile = path.join(await tmp, 'metadata.json');
  const args = [
    'buildx',
    'bake',
    '--file',
    file,
    '--metadata-file',
    metadataFile,
  ];

  if (opts.platform) {
    console.log(`Using platform: ${opts.platform}`);
    args.push('--set', `settings.platform=${opts.platform}`);
  }

  if (opts.args?.length) {
    console.log(`Using args: ${opts.args.join(' ')}`);
    args.push(...opts.args);
  }

  args.push(target);

  for (let tries = opts.tries ?? 0; ; tries--) {
    // the output goes straight to the log, so it is only shown once
    const result = await exec('docker', args, {
      reject: false,
      stdio: 'inherit',
    });
    if (!result.failed) {
      break;
    }
    const message = result.shortMessage ?? `docker bake ${target} failed`;
    if (result.signal || tries <= 0) {
      throw new DockerBakeError(message);
    }
    logger.warn(message);
    if (opts.delayMs) {
      logger.info(`Retrying in ${opts.delayMs}ms ...`);
      await setTimeout(opts.delayMs);
    }
  }

  const meta = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
  logger.debug({ meta }, 'metadata');

  return meta;
}

const signAttempts = 3;
const signDelay = 10_000;

/**
 * Signs an image with cosign, retrying a failed signing a few times.
 */
export async function sign(image: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    logger.info(`Signing ${image} ...`);
    const result = await exec('cosign', ['sign', '--yes', image], {
      reject: false,
      stdio: 'inherit',
    });
    if (!result.failed) {
      return;
    }
    const message = result.shortMessage ?? `Signing ${image} failed`;
    if (attempt >= signAttempts) {
      throw commandError(message);
    }
    logger.warn(message);
    logger.info(`Retrying in ${signDelay / 1000}s ...`);
    await setTimeout(signDelay);
  }
}
