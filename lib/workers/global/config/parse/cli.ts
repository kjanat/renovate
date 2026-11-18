import { arg, cli, command, flag } from '@kjanat/dreamcli';
import { isPlainObject } from '@sindresorhus/is';
import { flatDependencyDashboardOptions } from '../../../../config/migrations/custom/dependency-dashboard-migration.ts';
import { getOptions } from '../../../../config/options/index.ts';
import type { AllConfig } from '../../../../config/types.ts';
import { pkg } from '../../../../expose.ts';
import { logger } from '../../../../logger/index.ts';
import { coerceObject } from '../../../../util/object.ts';
import { regEx } from '../../../../util/regex.ts';
import { coersions } from './coersions.ts';
import type { ParseConfigOptions } from './types.ts';

export function getCliName(option: ParseConfigOptions): string {
  if (option.cli === false) {
    return '';
  }
  const nameWithHyphens = option.name.replace(
    regEx(/(?<upper>[A-Z])/g),
    '-$<upper>',
  );
  return `--${nameWithHyphens.toLowerCase()}`;
}

const options = getOptions().filter((option) => option.cli !== false);
const legacyOptions = Object.entries(flatDependencyDashboardOptions).map(
  ([name, { type }]) => ({ name, type, description: '' }),
);
const cliOptions = new Map(
  [...options, ...legacyOptions].map((option) => [getCliName(option), option]),
);

function createProgram(
  onConfig?: (flags: Record<string, unknown>, repositories: string[]) => void,
  includeLegacy = true,
): ReturnType<typeof cli> {
  let run = command('renovate')
    .arg('repositories', arg.string().variadic().default([]))
    .example(
      'singapore/lint-condo singapore/package-test',
      'Process two repositories',
    )
    .example(
      '--labels=renovate,dependency --ignore-unstable=false singapore/lint-condo',
      'Set configuration from the command line',
    );
  for (const [spelling, { type, description }] of cliOptions) {
    if (!includeLegacy && !description) {
      continue;
    }
    run = run.flag(
      spelling.slice(2),
      flag
        .custom((value) => {
          try {
            return coersions[type](String(value));
          } catch {
            throw new Error(`Expected a valid ${type} value`);
          }
        })
        .describe(description)
        .sensitive(),
    );
  }
  return cli('renovate')
    .builtins({ json: 'off', quiet: 'off' })
    .version(pkg.version)
    .default(
      run.action(({ flags, args }) => {
        const config = Object.fromEntries(
          Array.from(cliOptions, ([spelling, { name }]) => [
            name,
            flags[spelling.slice(2)],
          ]),
        );
        onConfig?.(config, args.repositories);
      }),
    );
}

function normalizeArgs(input: string[]): string[] {
  const args = input.slice(2);
  const separator = args.indexOf('--');
  const argv =
    separator === -1
      ? migrateArgs(args)
      : [...migrateArgs(args.slice(0, separator)), ...args.slice(separator)];
  const output: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      output.push(...argv.slice(i));
      break;
    }
    const option = cliOptions.get(token);
    if (option?.type === 'boolean') {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        output.push(`${token}=${value}`);
        i++;
      } else {
        output.push(`${token}=true`);
      }
    } else if (option && argv[i + 1] !== undefined) {
      output.push(`${token}=${argv[++i]}`);
    } else {
      output.push(token === '-v' ? '--version' : token);
    }
  }
  return output;
}

/**
 * Massage migrated configuration keys.
 * This runs before parsing so that
 * deprecated/bare flags like `--dry-run` (no value) are rewritten
 * before the parser consumes them.
 */
function migrateArgs(input: string[]): string[] {
  return input
    .map((a) =>
      a
        .replace(
          '--allow-post-upgrade-command-templating',
          '--allow-command-templating',
        )
        .replace('--allowed-post-upgrade-commands', '--allowed-commands')
        .replace('--endpoints=', '--host-rules=')
        .replace('--expose-env=true', '--trust-level=high')
        .replace('--expose-env', '--trust-level=high')
        .replace('--renovate-fork', '--include-forks')
        .replace('"platform":"', '"hostType":"')
        .replace('"endpoint":"', '"matchHost":"')
        .replace('"host":"', '"matchHost":"')
        .replace('--azure-auto-complete', '--platform-automerge') // migrate: azureAutoComplete
        .replace('--git-lab-automerge', '--platform-automerge') // migrate: gitLabAutomerge
        .replace(regEx(/^--dry-run$/), '--dry-run=true')
        .replace(regEx(/^--require-config$/), '--require-config=true')
        .replace('--aliases', '--registry-aliases')
        .replace('--include-forks=true', '--fork-processing=enabled')
        .replace('--include-forks', '--fork-processing=enabled')
        .replace('--recreate-closed=false', '--recreate-when=auto')
        .replace('--recreate-closed=true', '--recreate-when=always')
        .replace('--recreate-closed', '--recreate-when=always')
        .replace(
          regEx(/^--dependency-dashboard(?:=true)?$/),
          '--dependency-dashboard={"enabled":true}',
        )
        .replace(
          '--dependency-dashboard=false',
          '--dependency-dashboard={"enabled":false}',
        ),
    )
    .filter((a) => !a.startsWith('--git-fs'));
}

export async function parseEarlyFlags(
  input: string[] = process.argv,
): Promise<boolean> {
  const argv = normalizeArgs(input);
  for (const token of argv) {
    if (token === '--') {
      break;
    }
    if (['-h', '--help', '--version', '-V'].includes(token)) {
      const result = await createProgram(undefined, false).execute([token]);
      process.stdout.write(result.stdout.join(''));
      process.stderr.write(result.stderr.join(''));
      process.exitCode = result.exitCode;
      return true;
    }
  }
  return false;
}

export async function getConfig(input: string[]): Promise<AllConfig> {
  const config: Record<string, unknown> = {};

  const result = await createProgram((opts, repositories) => {
    if (repositories?.length) {
      config.repositories = repositories;
    }

    for (const option of options) {
      if (option.cli !== false && opts[option.name] !== undefined) {
        config[option.name] = opts[option.name];
        if (option.name === 'dryRun') {
          if (config[option.name] === 'true') {
            logger.warn('cli config dryRun property has been changed to full');
            config[option.name] = 'full';
          } else if (config[option.name] === 'false') {
            logger.warn('cli config dryRun property has been changed to null');
            config[option.name] = null;
          } else if (config[option.name] === 'null') {
            config[option.name] = null;
          }
        }
        if (option.name === 'requireConfig') {
          if (config[option.name] === 'true') {
            logger.warn(
              'cli config requireConfig property has been changed to required',
            );
            config[option.name] = 'required';
          } else if (config[option.name] === 'false') {
            logger.warn(
              'cli config requireConfig property has been changed to optional',
            );
            config[option.name] = 'optional';
          }
        }
      }
    }

    migrateDependencyDashboardFlags(opts, config);
  }).execute(normalizeArgs(input));
  if (result.error) {
    throw result.error;
  }
  return config;
}

/**
 * Moves the flags of the flat Dependency Dashboard options into `dependencyDashboard`, where fields it already sets take precedence.
 *
 * e.g. --dependency-dashboard-footer=... -> --dependency-dashboard='{"footer":...}'
 */
function migrateDependencyDashboardFlags(
  opts: Record<string, unknown>,
  config: Record<string, unknown>,
): void {
  const migrated: Record<string, unknown> = {};
  const oldFlags: string[] = [];
  for (const [name, { field }] of Object.entries(
    flatDependencyDashboardOptions,
  )) {
    if (opts[name] !== undefined) {
      migrated[field] = opts[name];
      oldFlags.push(getCliName({ name }));
    }
  }
  if (!oldFlags.length) {
    return;
  }

  const existing = coerceObject(config.dependencyDashboard);
  if (!isPlainObject(existing)) {
    logger.warn(
      { oldFlags },
      'Could not migrate cli config into --dependency-dashboard, as it is not an object',
    );
    return;
  }
  config.dependencyDashboard = { ...migrated, ...existing };
  logger.warn(
    { oldFlags },
    'cli config has been migrated into --dependency-dashboard',
  );
}
