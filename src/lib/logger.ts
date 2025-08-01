export type Logger = typeof console;

export const createLogger = (options: { dryRun: boolean; verbose: boolean }): Logger => {
  const prefix = options.dryRun ? '[DRY] ' : '';
  const verbose = !!options.verbose;
  return {
    ...console,
    group: (...args: any[]) => {
      console.group(prefix, ...args);
    },
    log: (...args: any[]) => {
      console.log(prefix, '[LOG] ', ...args);
    },
    warn: (...args: any[]) => {
      console.warn(prefix, '[WARN] ', ...args);
    },
    error: (...args: any[]) => {
      console.error(prefix, '[ERROR] ', ...args);
    },
    debug: (...args: any[]) => {
      if (verbose) {
        console.debug(prefix, '[DEBUG] ', ...args);
      }
    },
  };
};
