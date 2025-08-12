# stS Helper API

A serverless API for validator staking/unstaking recommendations, built for deployment on Vercel.

## API Endpoints

-   `GET /api/unstake-recommendation?amount=X` - Calculate optimal withdrawal recommendations
-   `GET /api/stake-recommendation` - Get delegation analysis and staking recommendations

## Action

Run the github action to track validator portfolios to define delegation boost.

## Environment Variables

Set this in your `.env` file for the action:

```bash
VALIDATOR_MAPPING={"13":["0xwallet1"],"14":["0xwallet2"]}
```
