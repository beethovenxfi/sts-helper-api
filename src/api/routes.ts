import 'dotenv/config';
import { Router, Response } from 'express';
import { calculateOptimalWithdrawals } from '../lib/withdrawal-calculator';
import { getValidatorAnalysisData } from '../lib/validator-delegation-analysis';

const router = Router();

// Main unstake calculation endpoint
router.get('/unstake-recommendation', async (req, res) => {
    try {
        const { amount } = req.query;

        // Validate amount parameter
        if (!amount) {
            return res.status(400).json({
                error: 'Missing required query parameter: amount',
                example: '/calculate-withdrawals?amount=1000000',
            });
        }

        const withdrawalAmount = parseFloat(amount as string);

        if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
            return res.status(400).json({
                error: 'Invalid withdrawal amount. Must be a positive number.',
                provided: amount,
            });
        }

        const recommendations = await calculateOptimalWithdrawals(withdrawalAmount);

        // Format response
        const response = {
            success: true,
            data: { recommendations },
            timestamp: new Date().toISOString(),
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

// Endpoint to get current delegation analysis and staking recommendations
router.get('/stake-recommendation', async (req, res) => {
    try {
        const boostData = await getValidatorstSBalances();
        const analysisData = await getValidatorAnalysisData(boostData.validatorData);

        const response = {
            data: {
                summary: {
                    totalDelegation: analysisData.summary.totalDelegation,
                    totalBoostedDelegation: analysisData.summary.totalBoostedDelegation,
                    allowedValidators: analysisData.summary.allowedValidators,
                },
                recommendations: {
                    stakeMore: analysisData.validators.underDelegated
                        .filter((v) => v.canReceiveDelegation)
                        .map((v) => ({
                            validatorId: v.validatorId,
                            recommendedAmount: Math.abs(v.difference),
                            reason: 'Under-delegated with available capacity',
                            priority: v.boostWeight || 0 > 0 ? 'high' : 'medium',
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
                    overDelegated: analysisData.validators.overDelegated
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
                        .sort((a, b) => parseFloat(b.validatorId) - parseFloat(a.validatorId)),
                    underDelegated: analysisData.validators.underDelegated
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
                        .sort((a, b) => parseFloat(b.validatorId) - parseFloat(a.validatorId)),
                    balanced: analysisData.validators.balanced
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
                        .sort((a, b) => parseFloat(b.validatorId) - parseFloat(a.validatorId)),
                    notAllowed: analysisData.validators.notAllowed
                        .map((v) => ({
                            validatorId: v.validatorId,
                            currentDelegation: v.currentDelegation,
                            expectedDelegation: v.expectedDelegation,
                            difference: v.difference,
                            status: v.status,
                        }))
                        .sort((a, b) => parseFloat(b.validatorId) - parseFloat(a.validatorId)),
                },
            },
            timestamp: new Date().toISOString(),
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
