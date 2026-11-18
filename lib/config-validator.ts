#!/usr/bin/env node
import 'source-map-support/register.js';
import './punycode.cjs';

import { styleText } from 'node:util';
import { arg, cli, command, flag } from '@kjanat/dreamcli';
import { createAdapter } from '@kjanat/dreamcli/runtime';
import { isNonEmptyStringAndNotWhitespace } from '@sindresorhus/is';
import { dequal } from 'dequal';
import { diffLines } from 'diff';
import fs from 'fs-extra';
import upath from 'upath';
import { getConfigFileNames } from './config/app-strings.ts';
import { GlobalConfig } from './config/global.ts';
import { massageConfig } from './config/massage.ts';
import { stringifyMigratedConfig } from './config/migrated-content.ts';
import { migrateConfig } from './config/migration.ts';
import type { RenovateConfig } from './config/types.ts';
import { validateConfig } from './config/validation.ts';
import { pkg } from './expose.ts';
import { init, logger } from './logger/index.ts';
import { getEnv } from './util/env.ts';
import { add as addHostRule } from './util/host-rules.ts';
import { regEx, regexEngineStatus } from './util/regex.ts';
import { getConfig as getFileConfig } from './workers/global/config/parse/file.ts';
import { parseConfigs } from './workers/global/config/parse/index.ts';
import { getParsedContent } from './workers/global/config/parse/util.ts';

await init();

const { pathExists, readFile, writeFile } = fs;

let returnVal = 0;

/**
 * Make sure that we've resolved configuration from the different places that Renovate users would expect them to be specified
 *
 * This then allows a `configType=repo` config to i.e. be validated alongside a `config.js` or `env RENOVATE_ALLOWED_COMMANDS=...`
 *
 * Note that we intentionally don't fully initialize Renovate and its modules, as we're not fully running, and it would require a Platform to be configured
 * */
async function partiallyGlobalInitialize(): Promise<void> {
  // NOTE that this doesn't allow command-line arguments
  const globalConfig = await parseConfigs(getEnv(), []);
  GlobalConfig.set(globalConfig);

  if (globalConfig.hostRules) {
    // this is the self-hosted admin's own config, so its `headers` are exempt from `allowedHeaders` altogether - see `hostRules.add()`
    for (const hostRule of globalConfig.hostRules) {
      addHostRule(hostRule, { trusted: true });
    }
  }
}

interface ValidateOptions {
  strict: boolean;
  isPreset?: boolean;
  /** the file to write any needed config migration to, when `--migrate` is set */
  migrateFile?: string;
}

function isMigratableFile(file: string): boolean {
  const basename = upath.basename(file);
  if (basename === 'package.json') {
    return false;
  }
  if (basename === '.renovaterc') {
    return true;
  }
  return ['.json', '.jsonc', '.json5'].includes(upath.extname(file));
}

/**
 * Writes `migratedConfig` to `file`, returning whether the migration was applied.
 */
async function writeMigratedConfig(
  file: string,
  migratedConfig: RenovateConfig,
): Promise<boolean> {
  if (!isMigratableFile(file)) {
    logger.warn(
      { file },
      'Config migration cannot be applied automatically to this file type',
    );
    return false;
  }

  try {
    const raw = await readFile(file, 'utf8');
    const { content } = stringifyMigratedConfig(file, raw, migratedConfig);
    await writeFile(file, content);
  } catch (err) {
    logger.warn({ file, err }, 'Config migration could not be written');
    return false;
  }
  logger.info(`Applied config migration to ${file}`);
  return true;
}

async function validate(
  configType: 'global' | 'repo',
  desc: string,
  config: RenovateConfig,
  { strict, isPreset = false, migrateFile }: ValidateOptions,
): Promise<void> {
  if (config.hostRules) {
    // a `global` config is the self-hosted administrator's own, so its `headers` are exempt from `allowedHeaders` altogether - see `hostRules.add()`; a `repo` config's `hostRules` are still constrained by this instance's `allowedHeaders`
    for (const hostRule of config.hostRules) {
      addHostRule(hostRule, { trusted: configType === 'global' });
    }
  }
  const { isMigrated, migratedConfig } = migrateConfig(config);
  if (isMigrated) {
    logger.warn(
      {
        oldConfig: config,
        newConfig: migratedConfig,
      },
      'Config migration necessary',
    );
    const changedObjects = diffLines(
      JSON.stringify(config, null, 2),
      JSON.stringify(migratedConfig, null, 2),
      { ignoreWhitespace: false, newlineIsToken: false },
    );
    const added = styleText('green', '+ ');
    const removed = styleText('red', '- ');
    const msg = changedObjects
      .flatMap((part) => {
        let linePrefix: string;
        if (part.added) {
          linePrefix = added;
        } else if (part.removed) {
          linePrefix = removed;
        } else {
          linePrefix = '  ';
        }
        return part.value
          .split('\n')
          .filter(isNonEmptyStringAndNotWhitespace)
          .map((line) =>
            line.replace(regEx(/^(?<ws> *)/), `${linePrefix}$<ws>`),
          );
      })
      .join('\n');
    // oxlint-disable-next-line renovate/logger-static-message -- the multi-line, colorized diff must be interpolated to stay readable; as a metadata field it is JSON-escaped onto one line
    logger.warn(`Config migration diff:\n${msg}`);
    let isMigrationApplied = false;
    if (migrateFile) {
      isMigrationApplied = await writeMigratedConfig(
        migrateFile,
        migratedConfig,
      );
    }
    if (strict && !isMigrationApplied) {
      returnVal = 1;
    }
  }
  const massagedConfig = massageConfig(migratedConfig);
  const res = await validateConfig(configType, massagedConfig, isPreset);
  if (res.errors.length) {
    logger.error(
      { file: desc, errors: res.errors },
      'Found errors in configuration',
    );
    returnVal = 1;
  }
  if (res.warnings.length) {
    logger.warn(
      { file: desc, warnings: res.warnings },
      'Found errors in configuration',
    );
    returnVal = 1;
  }
}

interface PackageJson {
  renovate?: RenovateConfig;
  'renovate-config'?: Record<string, RenovateConfig>;
}

(async () => {
  const validateFiles = command('validate')
    .description(
      `Validate your Renovate configuration (repo config, shared presets or global configuration) files\n` +
        // oxlint-disable-next-line renovate/no-hardcoded-docs-url -- CLI help text, no config available
        'If no [config-files...] are given, renovate-config-validator will look at the default config file locations (https://docs.renovatebot.com/configuration-options/)',
    )
    .arg('configFiles', arg.path({ type: 'file' }).variadic().default([]))
    .example('', 'Validate the configuration from the default locations')
    .example(
      '--strict config.js',
      'Require a warning-free global configuration',
    )
    .example('--migrate', 'Apply necessary configuration migrations')
    .example(
      '--no-global renovate.json5',
      'Validate a repository configuration',
    )
    .example(
      ({ name }) => `RENOVATE_CONFIG_FILE=obscure-name.json ${name}`,
      'Use a custom configuration path',
    )
    .flag(
      'strict',
      flag
        .boolean()
        .describe('Fail on warnings, errors, or required migrations'),
    )
    .flag(
      'migrate',
      flag.boolean().describe('Apply necessary configuration migrations'),
    )
    .flag(
      'global',
      flag
        .boolean()
        .negatable()
        .default(true)
        .describe('Treat explicit files as global self-hosted configuration'),
    )
    .action(async ({ args: { configFiles: files }, flags: opts, out }) => {
      await partiallyGlobalInitialize();
      const { strict, migrate } = opts;
      let filesValidated = 0;

      // without RE2, patterns are checked by RegExp, which accepts syntax RE2 rejects (e.g. lookahead)
      if (regexEngineStatus.type === 'unavailable') {
        logger.warn(
          { err: regexEngineStatus.err },
          'RE2 not usable, falling back to RegExp: regex validation may be inaccurate',
        );
      } else if (regexEngineStatus.type === 'ignored') {
        logger.debug(
          'RE2 ignored via RENOVATE_X_IGNORE_RE2: regex validation may be inaccurate',
        );
      }

      if (files.length) {
        let isGlobalConfig = true;
        if (opts.global === false) {
          isGlobalConfig = false;
        }
        const configType = isGlobalConfig ? 'global' : 'repo';
        for (const file of files) {
          try {
            const parsedContent = await getParsedContent(file);
            try {
              logger.info(`Validating ${file} as ${configType} config`);
              await validate(configType, file, parsedContent, {
                strict,
                migrateFile: migrate ? file : undefined,
              });
            } catch (err) {
              logger.warn({ file, err }, 'File is not valid Renovate config');
              returnVal = 1;
            }
          } catch (err) {
            logger.warn({ file, err }, 'File could not be parsed');
            returnVal = 1;
          }

          filesValidated++;
        }
      } else {
        for (const file of getConfigFileNames().filter(
          (name) => name !== 'package.json',
        )) {
          try {
            if (!(await pathExists(file))) {
              continue;
            }
            const parsedContent = await getParsedContent(file);
            try {
              logger.info(`Validating ${file}`);
              await validate('repo', file, parsedContent, {
                strict,
                migrateFile: migrate ? file : undefined,
              });
            } catch (err) {
              logger.warn({ file, err }, 'File is not valid Renovate config');
              returnVal = 1;
            }
          } catch (err) {
            logger.warn({ file, err }, 'File could not be parsed');
            returnVal = 1;
          }

          filesValidated++;
        }
        try {
          const pkgJson = JSON.parse(
            await readFile('package.json', 'utf8'),
          ) as PackageJson;
          if (pkgJson.renovate) {
            logger.info(`Validating package.json > renovate`);
            await validate(
              'repo',
              'package.json > renovate',
              pkgJson.renovate,
              {
                strict,
                migrateFile: migrate ? 'package.json' : undefined,
              },
            );

            filesValidated++;
          }
          if (pkgJson['renovate-config']) {
            logger.info(`Validating package.json > renovate-config`);
            for (const presetConfig of Object.values(
              pkgJson['renovate-config'],
            )) {
              await validate(
                'repo',
                'package.json > renovate-config',
                presetConfig,
                {
                  strict,
                  isPreset: true,
                  migrateFile: migrate ? 'package.json' : undefined,
                },
              );

              filesValidated++;
            }
          }
        } catch {
          // ignore
        }
        try {
          const env = getEnv();
          const fileConfig = await getFileConfig(env);
          if (!dequal(fileConfig, {})) {
            const file = env.RENOVATE_CONFIG_FILE ?? 'config.js';
            logger.info(`Validating ${file}`);
            try {
              await validate('global', file, fileConfig, { strict });
            } catch (err) {
              logger.error({ file, err }, 'File is not valid Renovate config');
              returnVal = 1;
            }
            filesValidated++;
          }
        } catch {
          // ignore
        }
      }
      if (returnVal === 0 && filesValidated) {
        logger.info(
          `Config validated successfully against ${filesValidated} file(s)`,
        );
      } else if (!filesValidated) {
        logger.warn(`No files to perform configuration validation against`);
      }
      // Use exitCode (not process.exit) so async log streams can flush
      out.setExitCode(returnVal);
    });

  const adapter = createAdapter();
  const separator = adapter.argv.indexOf('--');
  const endOfOptions = separator === -1 ? adapter.argv.length : separator;
  const argv = adapter.argv.map((token, index) => {
    if (index >= 2 && index < endOfOptions) {
      return token === '-v' ? '--version' : token;
    }
    return token;
  });
  await cli('renovate-config-validator')
    .version(pkg.version)
    .default(validateFiles)
    .run({ adapter: { ...adapter, argv } });
})().catch((e) => {
  // oxlint-disable-next-line no-console -- intentional: display critical error on CLI
  console.error(e);
  process.exit(99);
});
