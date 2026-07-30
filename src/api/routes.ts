import 'dotenv/config';
import { Router } from 'express';
import { calculateOptimalWithdrawals } from '../lib/withdrawal-recommendation';
import { getStakingRecommendation } from '../lib/staking-recommendation';

const router = Router();

// Main unstake calculation endpoint
router.get('/unstake-recommendation', async (req, res) => {
    try {
        const { amount } = req.query;

        // Validate amount parameter
        if (!amount) {
            return res.status(400).json({
                error: 'Missing required query parameter: amount in wei',
                example: '/calculate-withdrawals?amount=1000000',
            });
        }

        let withdrawalAmount: bigint;
        try {
            withdrawalAmount = BigInt(amount as string);
        } catch {
            withdrawalAmount = 0n;
        }

        if (withdrawalAmount <= 0n) {
            return res.status(400).json({
                error: 'Invalid withdrawal amount. Must be a positive number.',
                provided: amount,
            });
        }

        const recommendations = await calculateOptimalWithdrawals(withdrawalAmount);

        // Format response
        const response = {
            data: recommendations,
        };

        res.json(response);
    } catch (error) {
        console.error('Error calculating withdrawals:', error);
        res.status(500).json({
            error: 'Internal server error while calculating withdrawals',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
        });
    }
});

type AnalyzedValidator = Awaited<ReturnType<typeof getStakingRecommendation>>['allValidators'][number];

// Shared response shape for validator lists, sorted by validator id descending
function formatValidators(validators: AnalyzedValidator[]) {
    return validators
        .map((v) => ({
            validatorId: v.validatorId,
            currentDelegation: v.currentDelegation,
            expectedDelegation: v.expectedDelegation,
            difference: v.difference,
            stsBalance: v.stsBalance || 0,
            boostWeight: v.boostWeight || 0,
            maxDelegation: v.maxDelegation,
            remainingCapacity: v.remainingCapacity,
            canReceiveDelegation: v.canReceiveDelegation,
            status: v.status,
        }))
        .sort((a, b) => parseFloat(b.validatorId) - parseFloat(a.validatorId));
}

// Endpoint to get current delegation analysis and staking recommendations
router.get('/stake-recommendation', async (req, res) => {
    try {
        const analysisData = await getStakingRecommendation();

        const response = {
            data: {
                summary: {
                    totalDelegation: analysisData.summary.totalDelegation,
                    totalSelfDelegations: analysisData.summary.totalBoostedDelegation,
                    allowedValidators: analysisData.summary.allowedValidators,
                },
                recommendations: {
                    stakeMore: analysisData.validators.underDelegated
                        .filter((v) => v.canReceiveDelegation)
                        .map((v) => ({
                            validatorId: v.validatorId,
                            recommendedAmount: Math.abs(v.difference),
                            reason: 'Under-delegated with available capacity',
                            priority: (v.boostWeight || 0) > 0 ? 'high' : 'medium',
                        }))
                        .sort((a, b) => b.recommendedAmount - a.recommendedAmount),
                    avoidStaking: analysisData.validators.underDelegated
                        .filter((v) => !v.canReceiveDelegation)
                        .map((v) => ({
                            validatorId: v.validatorId,
                            reason: v.remainingCapacity < 500000 ? 'Low capacity' : 'At maximum capacity',
                        })),
                },
                validators: {
                    overDelegated: formatValidators(analysisData.validators.overDelegated),
                    underDelegated: formatValidators(analysisData.validators.underDelegated),
                    balanced: formatValidators(analysisData.validators.balanced),
                    notAllowed: formatValidators(analysisData.validators.notAllowed).map(
                        ({ validatorId, currentDelegation, expectedDelegation, difference, status }) => ({
                            validatorId,
                            currentDelegation,
                            expectedDelegation,
                            difference,
                            status,
                        }),
                    ),
                },
            },
        };

        res.json(response);
    } catch (error) {
        console.error('Error in delegation analysis:', error);
        res.status(500).json({
            error: 'Internal server error while analyzing delegations',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
        });
    }
});

export default router;
