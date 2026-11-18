import type { FlagBuilder, FlagConfig } from '@kjanat/dreamcli';
import {
  arg,
  cli,
  command,
  flag,
  osc8,
  resolveRenderContext,
} from '@kjanat/dreamcli';
import { ExitError, createAdapter } from '@kjanat/dreamcli/runtime';
import { isPlainObject, isString } from '@sindresorhus/is';
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

function optionFlag(type: string): FlagBuilder<FlagConfig> {
  switch (type) {
    case 'boolean':
      return flag.boolean();
    case 'integer':
      return flag.number({ int: true });
    case 'string':
      return flag.string();
    default:
      return flag.custom((value) => {
        try {
          return coersions[type](String(value));
        } catch {
          throw new Error(`Expected a valid ${type} value`);
        }
      });
  }
}

function createProgram(
  onConfig: (config: AllConfig) => void | number | Promise<number>,
  render?: ReturnType<typeof resolveRenderContext>,
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
    run = run.flag(
      spelling.slice(2),
      optionFlag(type)
        .describe(
          description
            .replace(
              regEx(
                /\[(?<label>[^\]]+)\]\((?<url>https?:\/\/[^)]+)\)|`(?<code>[^`\r\n]+)`/g,
              ),
              (match, label: string, url: string, code: string) => {
                if (code !== undefined) {
                  return render?.color.isColorSupported
                    ? render.color.yellow(code)
                    : match;
                }
                const styled =
                  render?.color.underline(render.color.cyan(label)) ?? label;
                return render?.isHyperlinkSupported
                  ? osc8(url, styled)
                  : styled;
              },
            )
            .replace(regEx(/\s*\r?\n\s*/g), ' '),
        )
        .sensitive(),
    );
  }
  return cli('renovate')
    .builtins({ json: 'off', quiet: 'off' })
    .manifest(pkg)
    .links()
    .default(
      run.action(async ({ flags, args, sources, out }) => {
        const config: Record<string, unknown> = {};
        for (const [spelling, { name, type }] of cliOptions) {
          const key = spelling.slice(2);
          if (sources.flags[key]?.stage !== 'cli') {
            continue;
          }
          const value = flags[key];
          config[name] =
            type === 'string' && isString(value)
              ? coersions.string(value)
              : value;
        }
        const code = await onConfig(
          resolveCliConfig(config, args.repositories),
        );
        if (code !== undefined) {
          out.setExitCode(code);
        }
      }),
    )
    .completions({ rootMode: 'surface' });
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
    if (
      token.endsWith('=') &&
      cliOptions.get(token.slice(0, -1))?.type === 'boolean'
    ) {
      output.push(`${token}true`);
      continue;
    }
    const option = cliOptions.get(token);
    if (option?.type === 'boolean') {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        output.push(`${token}=${value || 'true'}`);
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

export async function runRenovateCli(
  run: (config: AllConfig) => Promise<number>,
  adapter = createAdapter(),
): Promise<number> {
  const argv = normalizeArgs([...adapter.argv]);
  const forceColor = adapter.env.FORCE_COLOR;
  const colorEnabled =
    forceColor === undefined ? adapter.isTTY : forceColor !== '0';
  const render = resolveRenderContext(argv, {
    env: adapter.env,
    isTTY: adapter.isTTY,
    color: !adapter.env.NO_COLOR && colorEnabled,
    builtins: { json: 'off', quiet: 'off' },
  });
  try {
    await createProgram(
      run,
      argv[0] === 'completions' ? undefined : render,
    ).run({
      adapter: {
        ...adapter,
        argv: [...adapter.argv.slice(0, 2), ...argv],
        exit: (code) => {
          throw new ExitError(code);
        },
      },
    });
  } catch (err) {
    if (err instanceof ExitError) {
      return err.code;
    }
    throw err;
  }
}

export async function getConfig(input: string[]): Promise<AllConfig> {
  let config: AllConfig = {};
  const result = await createProgram((resolved) => {
    config = resolved;
  }).execute(normalizeArgs(input));
  if (result.error) {
    throw result.error;
  }
  return config;
}

function resolveCliConfig(
  opts: Record<string, unknown>,
  repositories: string[],
): AllConfig {
  const config: Record<string, unknown> = {};
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
