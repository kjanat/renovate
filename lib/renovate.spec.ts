import * as otel from './instrumentation/index.ts';
import { runRenovateCli } from './workers/global/config/parse/cli.ts';
import * as renovateWorker from './workers/global/index.ts';

vi.mock('./instrumentation/index.ts');
vi.mock('./proxy.ts');
vi.mock('./workers/global/index.ts');
vi.mock('./workers/global/config/parse/cli.ts');

describe('renovate', () => {
  it.each([false, true])(
    'starts only for normal runs (early flag handled: %s)',
    async (earlyExit) => {
      vi.resetModules();
      vi.clearAllMocks();
      const config = { repositories: ['org/repo'] };
      vi.mocked(runRenovateCli).mockImplementationOnce(async (run) => {
        if (earlyExit) {
          return 0;
        }
        return await run(config);
      });
      vi.mocked(otel.instrument).mockImplementationOnce((_, cb) => cb());
      const waiter = new Promise<void>((resolve) => {
        vi.mocked(otel.shutdown).mockImplementationOnce(() => {
          resolve();
          return Promise.resolve();
        });
      });
      await vi.importActual('./renovate.ts');
      await waiter;
      expect(vi.mocked(renovateWorker.start).mock.calls).toEqual(
        earlyExit ? [] : [[config]],
      );
      expect(otel.shutdown).toHaveBeenCalledTimes(1);
    },
  );
});
