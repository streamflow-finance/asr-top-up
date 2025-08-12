import { buildSendThrottler } from '@streamflow/common/solana';
import PQueue from 'p-queue';

export const STREAMFLOW_TREASURY = '5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw';

// Transfer usually requires fewer units unless we need to create an ATA
// This is the default CU for the transfer for 1 reward pool
export const DEFAULT_CU = 60_000;
// Constant Priority Fee in micro-lamports per CU
export const COMPUTE_PRICE = 1_000_000;

export const SEND_THROTTLER: PQueue = buildSendThrottler(2);

// For BN calculations as percentage can be non-whole number
export const PRECISION_DECIMALS = 6;
export const MINUTES_IN_YEAR = 525_600;
