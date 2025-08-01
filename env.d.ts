declare namespace NodeJS {
  interface ProcessEnv {
    // Logging
    DRY_RUN: '0' | '1' | undefined;
    DEBUG_LOG: 'true' | 'false' | undefined;

    // RPC
    RPC_URL: string;

    // Top-up config
    POOL_CONFIGS: string;
    PERIOD_IN_MINUTES: string;

    SOL_BALANCE_WARNING_THRESHOLD: string;

    // Notify
    WEBHOOK_URL: string | undefined;

    // Set by runner
    GITHUB_WORKFLOW: string;
    GITHUB_REPOSITORY: string;
    GITHUB_RUN_ID: string;
  }
}
