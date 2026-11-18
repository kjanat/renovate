import { stripVTControlCharacters } from 'node:util';
import { createTestAdapter } from '@kjanat/dreamcli/testkit';
import { execa } from 'execa';
import { pkg } from '../../../../expose.ts';
import { logger } from '../../../../logger/index.ts';
import { DockerDatasource } from '../../../../modules/datasource/docker/index.ts';
import getArgv from './__fixtures__/argv.ts';
import * as cli from './cli.ts';
import type { ParseConfigOptions } from './types.ts';

describe('workers/global/config/parse/cli', () => {
  let argv: string[];

  beforeEach(() => {
    argv = getArgv();
  });

  describe('.getCliName(definition)', () => {
    it('generates CLI value', () => {
      const option: ParseConfigOptions = {
        name: 'oneTwoThree',
      };
      expect(cli.getCliName(option)).toBe('--one-two-three');
    });

    it('generates returns empty if CLI false', () => {
      const option: ParseConfigOptions = {
        name: 'oneTwoThree',
        cli: false,
      };
      expect(cli.getCliName(option)).toBe('');
    });
  });

  describe('.getConfig(argv)', () => {
    it('returns empty argv', async () => {
      await expect(cli.getConfig(argv)).resolves.toEqual({});
    });

    it('supports boolean no value', async () => {
      argv.push('--config-migration');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        configMigration: true,
      });
      argv = argv.slice(0, -1);
    });

    it('supports boolean space true', async () => {
      argv.push('--config-migration');
      argv.push('true');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        configMigration: true,
      });
    });

    it('throws exception for invalid boolean value', async () => {
      argv.push('--config-migration');
      argv.push('badvalue');
      await expect(cli.getConfig(argv)).rejects.toThrow(
        'Invalid boolean value',
      );
    });

    it('supports boolean space false', async () => {
      argv.push('--config-migration');
      argv.push('false');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        configMigration: false,
      });
    });

    it('supports boolean equals true', async () => {
      argv.push('--config-migration=true');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        configMigration: true,
      });
    });

    it('supports boolean equals false', async () => {
      argv.push('--config-migration=false');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        configMigration: false,
      });
    });

    it('preserves an empty explicit boolean as true', async () => {
      argv.push('--config-migration=');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        configMigration: true,
      });
    });

    it('parses integer configuration flags', async () => {
      argv.push('--pr-hourly-limit=3');
      await expect(cli.getConfig(argv)).resolves.toEqual({ prHourlyLimit: 3 });
    });

    it('rejects a partially numeric integer', async () => {
      argv.push('--pr-hourly-limit=3oops');
      await expect(cli.getConfig(argv)).rejects.toThrow('Invalid number value');
    });

    it('supports list single', async () => {
      argv.push('--labels=a');
      await expect(cli.getConfig(argv)).resolves.toEqual({ labels: ['a'] });
    });

    it('supports list multiple', async () => {
      argv.push('--labels=a,b,c');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        labels: ['a', 'b', 'c'],
      });
    });

    it('supports base branch patterns', async () => {
      argv.push('--base-branch-patterns=main,develop');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        baseBranchPatterns: ['main', 'develop'],
      });
    });

    it('supports string', async () => {
      argv.push('--token=a');
      await expect(cli.getConfig(argv)).resolves.toEqual({ token: 'a' });
    });

    it('supports repositories', async () => {
      argv.push('foo');
      argv.push('bar');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        repositories: ['foo', 'bar'],
      });
    });

    it('parses json lists correctly', async () => {
      argv.push(
        `--host-rules=[{"matchHost":"docker.io","hostType":"${DockerDatasource.id}","username":"user","password":"password"}]`,
      );
      await expect(cli.getConfig(argv)).resolves.toEqual({
        hostRules: [
          {
            matchHost: 'docker.io',
            hostType: DockerDatasource.id,
            username: 'user',
            password: 'password',
          },
        ],
      });
    });

    it('parses [] correctly as empty list of hostRules', async () => {
      argv.push(`--host-rules=[]`);
      await expect(cli.getConfig(argv)).resolves.toEqual({
        hostRules: [],
      });
    });

    it('parses an empty string correctly as empty list of hostRules', async () => {
      argv.push(`--host-rules=`);
      await expect(cli.getConfig(argv)).resolves.toEqual({
        hostRules: [],
      });
    });

    it.each`
      arg                               | config
      ${'--endpoints='}                 | ${{ hostRules: [] }}
      ${'--azure-auto-complete=false'}  | ${{ platformAutomerge: false }}
      ${'--azure-auto-complete=true'}   | ${{ platformAutomerge: true }}
      ${'--azure-auto-complete'}        | ${{ platformAutomerge: true }}
      ${'--git-lab-automerge=false'}    | ${{ platformAutomerge: false }}
      ${'--git-lab-automerge=true'}     | ${{ platformAutomerge: true }}
      ${'--git-lab-automerge'}          | ${{ platformAutomerge: true }}
      ${'--recreate-closed=false'}      | ${{ recreateWhen: 'auto' }}
      ${'--recreate-closed=true'}       | ${{ recreateWhen: 'always' }}
      ${'--recreate-closed'}            | ${{ recreateWhen: 'always' }}
      ${'--recreate-when=auto'}         | ${{ recreateWhen: 'auto' }}
      ${'--recreate-when=always'}       | ${{ recreateWhen: 'always' }}
      ${'--recreate-when=never'}        | ${{ recreateWhen: 'never' }}
      ${'--dependency-dashboard'}       | ${{ dependencyDashboard: { enabled: true } }}
      ${'--dependency-dashboard=true'}  | ${{ dependencyDashboard: { enabled: true } }}
      ${'--dependency-dashboard=false'} | ${{ dependencyDashboard: { enabled: false } }}
    `('"$arg" -> $config', async ({ arg, config }) => {
      argv.push(arg);
      await expect(cli.getConfig(argv)).resolves.toMatchObject(config);
    });

    describe('migrates the flat Dependency Dashboard flags', () => {
      it('moves them into dependencyDashboard with their old types', async () => {
        argv.push(
          '--customize-dashboard={"repoProblemsHeader":"problems"}',
          '--dependency-dashboard-autoclose',
          '--dependency-dashboard-footer',
          'line one\\nline two',
          '--dependency-dashboard-header=header',
          '--dependency-dashboard-labels=a,b',
          '--dependency-dashboard-o-s-v-vulnerability-summary=all',
          '--dependency-dashboard-report-abandonment=false',
          '--dependency-dashboard-title=title',
        );

        await expect(cli.getConfig(argv)).resolves.toEqual({
          dependencyDashboard: {
            customize: { repoProblemsHeader: 'problems' },
            autoclose: true,
            footer: 'line one\nline two',
            header: 'header',
            labels: ['a', 'b'],
            osvVulnerabilitySummary: 'all',
            reportAbandonment: false,
            title: 'title',
          },
        });
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          {
            oldFlags: [
              '--customize-dashboard',
              '--dependency-dashboard-autoclose',
              '--dependency-dashboard-footer',
              '--dependency-dashboard-header',
              '--dependency-dashboard-labels',
              '--dependency-dashboard-o-s-v-vulnerability-summary',
              '--dependency-dashboard-report-abandonment',
              '--dependency-dashboard-title',
            ],
          },
          'cli config has been migrated into --dependency-dashboard',
        );
      });

      it('prefers fields set in --dependency-dashboard', async () => {
        argv.push(
          '--dependency-dashboard={"footer":"new","enabled":true}',
          '--dependency-dashboard-footer=old',
          '--dependency-dashboard-title=title',
        );

        await expect(cli.getConfig(argv)).resolves.toEqual({
          dependencyDashboard: { enabled: true, footer: 'new', title: 'title' },
        });
      });

      it('keeps a boolean --dependency-dashboard', async () => {
        argv.push('--dependency-dashboard', '--dependency-dashboard-footer=f');

        await expect(cli.getConfig(argv)).resolves.toEqual({
          dependencyDashboard: { enabled: true, footer: 'f' },
        });
      });

      it('leaves a --dependency-dashboard which is not an object', async () => {
        argv.push(
          '--dependency-dashboard=5',
          '--dependency-dashboard-footer=footer',
        );

        await expect(cli.getConfig(argv)).resolves.toEqual({
          dependencyDashboard: 5,
        });
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          { oldFlags: ['--dependency-dashboard-footer'] },
          'Could not migrate cli config into --dependency-dashboard, as it is not an object',
        );
      });

      it('throws for an invalid old value', async () => {
        argv.push('--dependency-dashboard-autoclose=yes');

        await expect(cli.getConfig(argv)).rejects.toThrow(
          'Invalid boolean value',
        );
      });
    });

    it('parses json object correctly when empty', async () => {
      argv.push(`--onboarding-config=`);
      await expect(cli.getConfig(argv)).resolves.toEqual({
        onboardingConfig: {},
      });
    });

    it('parses json {} object correctly', async () => {
      argv.push(`--onboarding-config={}`);
      await expect(cli.getConfig(argv)).resolves.toEqual({
        onboardingConfig: {},
      });
    });

    it('parses json object correctly', async () => {
      argv.push(`--onboarding-config={"extends": ["config:recommended"]}`);
      await expect(cli.getConfig(argv)).resolves.toEqual({
        onboardingConfig: {
          extends: ['config:recommended'],
        },
      });
    });

    it('throws exception for invalid json object', async () => {
      argv.push('--onboarding-config=Hello_World');
      await expect(cli.getConfig(argv)).rejects.toThrow(
        'Expected a valid object value',
      );
    });

    it('dryRun boolean true', async () => {
      argv.push('--dry-run=true');
      await expect(cli.getConfig(argv)).resolves.toEqual({ dryRun: 'full' });
    });

    it('dryRun no value', async () => {
      argv.push('--dry-run');
      await expect(cli.getConfig(argv)).resolves.toEqual({ dryRun: 'full' });
    });

    it('dryRun boolean false', async () => {
      argv.push('--dry-run=false');
      await expect(cli.getConfig(argv)).resolves.toEqual({ dryRun: null });
    });

    it('dryRun  null', async () => {
      argv.push('--dry-run=null');
      await expect(cli.getConfig(argv)).resolves.toEqual({ dryRun: null });
    });

    it('requireConfig boolean true', async () => {
      argv.push('--require-config=true');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        requireConfig: 'required',
      });
    });

    it('requireConfig no value', async () => {
      argv.push('--require-config');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        requireConfig: 'required',
      });
    });

    it('requireConfig boolean false', async () => {
      argv.push('--require-config=false');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        requireConfig: 'optional',
      });
    });

    it('dryRun keeps a value that is already current', async () => {
      argv.push('--dry-run=extract');
      await expect(cli.getConfig(argv)).resolves.toEqual({ dryRun: 'extract' });
    });

    it('requireConfig keeps a value that is already current', async () => {
      argv.push('--require-config=ignored');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        requireConfig: 'ignored',
      });
    });
  });

  describe('CLI dispatch', () => {
    it('generates clean Zsh completions for root flags without running the worker', async () => {
      const run = vi.fn();
      const chunks: string[] = [];
      const adapter = createTestAdapter({
        argv: ['node', 'renovate', 'completions', 'zsh'],
        isTTY: true,
        env: { FORCE_COLOR: '1', FORCE_HYPERLINKS: '1' },
        stdout: (chunk) => {
          chunks.push(chunk);
        },
      });

      await expect(cli.runRenovateCli(run, adapter)).resolves.toBe(0);
      expect(run).not.toHaveBeenCalled();
      const script = chunks.join('');
      expect(script).toContain('#compdef renovate');
      expect(script).toContain('--platform[');
      expect(script).toBe(stripVTControlCharacters(script));
    });

    it('hands parsed config to the default action and returns its exit status', async () => {
      const run = vi.fn().mockResolvedValue(5);
      const adapter = createTestAdapter({
        argv: ['node', 'renovate', '--dry-run', 'org/repo'],
      });

      await expect(cli.runRenovateCli(run, adapter)).resolves.toBe(5);
      expect(run).toHaveBeenCalledExactlyOnceWith({
        dryRun: 'full',
        repositories: ['org/repo'],
      });
    });

    it('keeps multiline option prose in the description column', async () => {
      const { stdout } = await execa('node', ['lib/renovate.ts', '--help'], {
        env: { NO_COLOR: '1' },
      });
      const lines = stdout.split('\n');
      const start = lines.findIndex((line) =>
        line.includes('--allowed-unsafe-executions'),
      );
      const end = lines.findIndex((line) =>
        line.includes('--assign-automerge'),
      );
      const description = lines.slice(start + 1, end);

      expect(start).toBeGreaterThan(-1);
      expect(description.length).toBeGreaterThan(1);
      expect(description.every((line) => line.startsWith(' '.repeat(20)))).toBe(
        true,
      );
    });

    it.each(['-v', '--version'])(
      'dispatches %s to built-in version',
      async (token) => {
        const { stdout } = await execa('node', ['lib/renovate.ts', token]);
        expect(stdout).toBe(pkg.version);
      },
    );

    it('renders the development branch link without Markdown syntax', async () => {
      const { stdout } = await execa('node', ['lib/renovate.ts', '--help'], {
        env: { FORCE_HYPERLINKS: '1' },
      });
      expect(stripVTControlCharacters(stdout)).toMatch(/development\s+branch/);
      expect(stdout).not.toContain('[development branch](');
      expect(stdout).toContain('\u001B]8;;https://support.atlassian.com/');
    });

    it('underlines help links and colors inline code in a terminal', async () => {
      const chunks: string[] = [];
      const adapter = createTestAdapter({
        argv: ['node', 'renovate', '--help'],
        isTTY: true,
        stdout: (chunk) => {
          chunks.push(chunk);
        },
      });

      await expect(cli.runRenovateCli(vi.fn(), adapter)).resolves.toBe(0);
      const help = chunks.join('');
      expect(help).toContain('\u001B[4m\u001B[36mdevelopment');
      expect(help).toContain('\u001B[33mtrue\u001B[39m');
    });

    it('leaves arguments after the separator untouched', async () => {
      argv.push('--', '--version', '--dry-run');
      await expect(cli.getConfig(argv)).resolves.toEqual({
        repositories: ['--version', '--dry-run'],
      });
    });

    it('leaves a flag-like required value with its option', async () => {
      argv.push('--token', '-v');
      await expect(cli.getConfig(argv)).resolves.toEqual({ token: '-v' });
    });
  });
});
