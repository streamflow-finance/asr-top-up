# ASR Top-Up Script

An automated solution for maintaining target APY rates in Active Staking Rewards (ASR) pools on Solana by intelligently calculating and executing token top-ups based on current pool metrics and funding periods.

## Overview

This script monitors Solana staking pools and automatically transfers tokens to reward pools when needed to maintain target Annual Percentage Yield (APY) rates. It supports multiple pools with different APY targets and funding intervals, with built-in safety checks, webhook notifications, and dry-run capabilities.

### Key Features

- 🎯 **Automated APY Management**: Maintains target APY rates across multiple staking pools
- ⏰ **Flexible Scheduling**: Configurable funding periods (hourly, daily, etc.)
- 🔔 **Smart Notifications**: Webhook alerts for low balances, errors, and important events
- 🧪 **Dry Run Mode**: Test configurations without executing transactions
- 📊 **CSV Reporting**: Detailed transaction logs and pool metrics
- 🛡️ **Safety Checks**: Balance validation and transaction cost estimation
- ⚡ **Rate Limiting**: Built-in throttling to prevent network overload

## Prerequisites

- **Node.js**: Version 21 or higher (v22 recommended)
- **pnpm**: Package manager
- **Solana Wallet**: Private key(s) for funding wallet(s)
- **RPC Access**: Solana RPC endpoint URL

## Installation

```sh
# Use the correct Node.js version
nvm use

# Install dependencies
pnpm install
```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```dotenv
# Required Settings
# Solana Network
RPC_URL=https://api.mainnet-beta.solana.com

# Pool Configuration (JSON string - see example below)
POOL_CONFIGS=[{"id":"1","name":"Example Pool",...}]

# Execution Settings
PERIOD_IN_MINUTES=60

# Optional Settings
DRY_RUN=0
DEBUG_LOG=false
WEBHOOK_URL=https://your-webhook-endpoint.com/notify
SOL_BALANCE_WARNING_THRESHOLD=5000000
```

### Pool Configuration Example

The `POOL_CONFIGS` should be a JSON string containing an array of pool configurations:

```json
[
  {
    "id": "1",
    "name": "Pool 1",
    "stakePoolAddress": "YourStakePoolAddressHere",
    "privateKey": "your-base58-private-key-or-uint8array-string",
    "targetAPY": 5,
    "fundingPeriodMinutes": 60,
    "feeValue": "YourPDAFromStreamflowHere"
  },
  {
    "id": "2",
    "name": "Pool 2",
    "stakePoolAddress": "YourStakePoolAddressHere",
    "privateKey": "your-base58-private-key-or-uint8array-string",
    "targetAPY": 8,
    "fundingPeriodMinutes": 360,
    "feeValue": "YourPDAFromStreamflowHere"
  }
]
```

### Environment Variables Reference

| Variable                        | Required | Description                               | Example                                |
| ------------------------------- | -------- | ----------------------------------------- | -------------------------------------- |
| `RPC_URL`                       | ✅       | Solana RPC endpoint                       | `https://api.mainnet-beta.solana.com`  |
| `POOL_CONFIGS`                  | ✅       | JSON array of pool configurations         | See example above                      |
| `PERIOD_IN_MINUTES`             | ✅       | Funding period to process (filters pools) | `60`, `360`, `1440`, etc               |
| `DRY_RUN`                       | ❌       | Run without executing transactions        | `0` or `1`                             |
| `DEBUG_LOG`                     | ❌       | Enable verbose logging                    | `true` or `false`                      |
| `WEBHOOK_URL`                   | ❌       | Endpoint for notifications                | `https://discord.com/api/webhooks/...` |
| `SOL_BALANCE_WARNING_THRESHOLD` | ❌       | Low balance alert threshold (lamports)    | `5000000`                              |

## Usage

### Run the Script

```sh
# Production run
pnpm run start

# Dry run (no transactions executed)
DRY_RUN=1 pnpm run start

# With debug logging
DEBUG_LOG=true pnpm run start
```

### Run Tests

```sh
pnpm run test
```

### Format Code

```sh
pnpm run format
```

## How It Works

1. **Pool Filtering**: Script filters configured pools by `PERIOD_IN_MINUTES`
2. **Balance Checks**: Validates SOL and token balances in funding wallets
3. **APY Calculation**: Determines required tokens to maintain target APY
4. **Safety Validation**: Estimates transaction costs and checks balances
5. **Execution**: Transfers tokens to reward pools (unless in dry-run mode)
6. **Reporting**: Logs results and writes CSV output to `/tmp/result.csv`
7. **Notifications**: Sends alerts for errors, low balances, or important events

## Automated Scheduling

### GitHub Actions

This script supports automated execution via GitHub Actions. The `.github/workflows` directory contains example workflow files for different intervals.

To set up automated execution:

1. Copy an example workflow file
2. Modify the cron schedule using [Crontab Guru](https://crontab.guru/)
3. Configure repository secrets for environment variables
4. Enable GitHub Actions in your repository

### Example Workflow Schedule

```yaml
# Run every hour
schedule:
  - cron: '0 * * * *'

# Run every 6 hours
schedule:
  - cron: '0 */6 * * *'

# Run daily at 12:00 UTC
schedule:
  - cron: '0 12 * * *'
```

## Security Considerations

⚠️ **Important Security Notes:**

- Store private keys securely using GitHub Secrets
- Use dedicated funding wallets with minimal required balances

## Troubleshooting

### Common Issues

**"RPC_URL is required" Error**

- Ensure `RPC_URL` is set in your environment variables
- Verify the RPC endpoint is accessible and responsive

**"Not enough SOL balance" Warning**

- Check your funding wallet SOL balance
- Adjust `SOL_BALANCE_WARNING_THRESHOLD` if needed
- Add more SOL to the funding wallet

**"POOL_CONFIGS are required" Error**

- Verify `POOL_CONFIGS` is valid JSON
- Check that all required fields are present in each pool config

**No Pools Processed**

- Ensure `PERIOD_IN_MINUTES` matches at least one pool's `fundingPeriodMinutes`
- Check that pools are configured correctly

### Debug Mode

Enable debug logging for detailed execution information:

```sh
DEBUG_LOG=true pnpm run start
```

## Output

The script generates:

- **Console logs**: Real-time execution status and results
- **CSV file**: Detailed results written to `/tmp/result.csv`
- **Webhook notifications**: Alerts sent to configured endpoint (if configured)

### CSV Output Format

| Timestamp | Pool ID | Pool Name | Staked Amount | Funder Token Account Balance | Total Top-up Amount | Tx Signature |
| --------- | ------- | --------- | ------------- | ---------------------------- | ------------------- | ------------ |

## License

Apache 2.0
