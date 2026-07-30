# stS Helper API

A serverless API for validator staking/unstaking recommendations, built for deployment on Vercel.

## API Endpoints

-   `GET /api/unstake-recommendation?amount=X` - Calculate optimal withdrawal recommendations
-   `GET /api/stake-recommendation` - Get delegation analysis and staking recommendations

## Adding a new validator

Add the validator id to `ALLOWED_VALIDATORS` in `src/lib/constants.ts` — that's all that is
needed for it to show up in stake/unstake recommendations, even before it has any delegation.
If the validator owner holds stS (for delegation boost), also add their wallets to the
`VALIDATOR_MAPPING` secret used by the GitHub action.

## Action

Run the github action to track validator portfolios to define delegation boost.

## Environment Variables

Set this in your `.env` file for the action:

```bash
VALIDATOR_MAPPING={"13":["0xwallet1"],"14":["0xwallet2"]}
```
