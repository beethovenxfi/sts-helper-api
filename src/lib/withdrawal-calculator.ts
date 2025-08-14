import * as fs from 'fs';
import { ALLOWED_VALIDATORS } from './constants';
import { calculateExpectedDelegations, getDelegationData, loadValidatorBoostData, ValidatorBoostData } from './helper';

interface WithdrawalRecommendation {
    withdrawalAmount: number;
    validatorId: string;
}

interface ValidatorAnalysis {
    validatorId: string;
    currentDelegation: number;
    expectedDelegation: number;
    overDelegated: number;
    isOverDelegated: boolean;
}

function calculateWithdrawalsWithPriority(
    notAllowedValidators: ValidatorAnalysis[],
    allowedValidators: ValidatorAnalysis[],
    withdrawalAmount: number,
): WithdrawalRecommendation[] {
    const recommendations: WithdrawalRecommendation[] = [];
    let remainingWithdrawal = withdrawalAmount;

    // PRIORITY 1: Withdraw from not-allowed validators first (withdraw to 0)
    if (notAllowedValidators.length > 0) {
        // Sort by highest delegation first to prioritize biggest withdrawals
        const sortedNotAllowed = notAllowedValidators.sort((a, b) => b.currentDelegation - a.currentDelegation);

        for (const validator of sortedNotAllowed) {
            if (remainingWithdrawal <= 0) break;

            // Withdraw all delegation from not-allowed validators (or remaining withdrawal amount)
            const availableWithdrawal = Math.min(validator.currentDelegation, remainingWithdrawal);

            if (availableWithdrawal > 0) {
                // Include even tiny amounts like 0.005S
                recommendations.push({
                    withdrawalAmount: availableWithdrawal,
                    validatorId: validator.validatorId,
                });

                remainingWithdrawal -= availableWithdrawal;
            }
        }
    }

    // PRIORITY 2: If withdrawal amount remains, withdraw from over-delegated allowed validators
    if (remainingWithdrawal > 0) {
        // Filter to only over-delegated validators and sort by highest over-delegation first
        const overDelegatedValidators = allowedValidators
            .filter((v) => v.isOverDelegated && v.overDelegated > 1)
            .sort((a, b) => b.overDelegated - a.overDelegated);

        if (overDelegatedValidators.length === 0) {
            console.log('⚠️  No over-delegated allowed validators found for remaining withdrawal.');
        } else {
            for (const validator of overDelegatedValidators) {
                if (remainingWithdrawal <= 0) break;

                // Calculate how much can be withdrawn from this validator
                const availableWithdrawal = Math.min(validator.overDelegated, remainingWithdrawal);

                if (availableWithdrawal > 0.01) {
                    recommendations.push({
                        withdrawalAmount: availableWithdrawal,
                        validatorId: validator.validatorId,
                    });

                    remainingWithdrawal -= availableWithdrawal;
                }
            }
        }
    }

    if (remainingWithdrawal > 0) {
        const totalAvailableFromNotAllowed = notAllowedValidators.reduce((sum, v) => sum + v.currentDelegation, 0);
        const totalAvailableFromOverDelegated = allowedValidators
            .filter((v) => v.isOverDelegated && v.overDelegated > 1)
            .reduce((sum, v) => sum + v.overDelegated, 0);

        console.log(
            `\n⚠️  Could not allocate ${remainingWithdrawal.toLocaleString()} S - insufficient available withdrawals`,
        );
        console.log(`   Available from not-allowed validators: ${totalAvailableFromNotAllowed.toLocaleString()} S`);
        console.log(
            `   Available from over-delegated validators: ${totalAvailableFromOverDelegated.toLocaleString()} S`,
        );
        console.log(
            `   Total available: ${(
                totalAvailableFromNotAllowed + totalAvailableFromOverDelegated
            ).toLocaleString()} S`,
        );
    }

    return recommendations;
}

export async function calculateOptimalWithdrawals(withdrawalAmount: number): Promise<WithdrawalRecommendation[]> {
    try {
        // Load validator boost weights
        const boostWeights = await loadValidatorBoostData();

        if (boostWeights.length === 0) {
            console.log('❌ No boost weight data found. Please run track-validator-delegation-boost.ts first.');
            return [];
        }

        // Get delegation data
        const delegationData = await getDelegationData();

        if (delegationData.length === 0) {
            console.log('❌ No delegation data found.');
            return [];
        }

        // Calculate total delegation
        const totalDelegation = delegationData.reduce((sum, d) => sum + parseFloat(d.assetsDelegated), 0);

        const totalBoostedDelegation = Array.from(boostWeights.values()).reduce(
            (sum, boost) => sum + boost.totalSBalance,
            0,
        );

        // Calculate expected delegations using boost weights
        const allDelegationValidators = delegationData.map((d) => d.validatorId);
        const expectedDelegations = calculateExpectedDelegations(
            boostWeights,
            totalDelegation,
            totalBoostedDelegation,
            allDelegationValidators,
        );

        // Analyze each validator - including not-allowed ones for withdrawal
        const validatorAnalyses: ValidatorAnalysis[] = [];
        const notAllowedValidators: ValidatorAnalysis[] = [];

        for (const delegation of delegationData) {
            const currentDelegation = parseFloat(delegation.assetsDelegated);

            if (!ALLOWED_VALIDATORS.includes(delegation.validatorId)) {
                // Not-allowed validators should be withdrawn to 0
                if (currentDelegation > 0) {
                    // Include ALL delegations from not-allowed validators, even tiny amounts
                    notAllowedValidators.push({
                        validatorId: delegation.validatorId,
                        currentDelegation,
                        expectedDelegation: 0, // Should be 0
                        overDelegated: currentDelegation, // All delegation is over-delegation
                        isOverDelegated: true,
                    });
                }
                continue;
            }

            const expectedDelegation = expectedDelegations.get(delegation.validatorId) || 0;
            const difference = currentDelegation - expectedDelegation;
            const isOverDelegated = difference > 1; // Consider over-delegated if difference > 1 S

            validatorAnalyses.push({
                validatorId: delegation.validatorId,
                currentDelegation,
                expectedDelegation,
                overDelegated: Math.max(0, difference),
                isOverDelegated,
            });
        }

        // remove our own validator from withdrawals
        const ourValidatorId = '44';
        const ourValidatorIndex = validatorAnalyses.findIndex((r) => r.validatorId === ourValidatorId);
        if (ourValidatorIndex !== -1) {
            validatorAnalyses.splice(ourValidatorIndex, 1);
        }

        // Calculate withdrawal recommendations - prioritize not-allowed validators first
        const recommendations = calculateWithdrawalsWithPriority(
            notAllowedValidators,
            validatorAnalyses,
            withdrawalAmount,
        );

        return recommendations;
    } catch (error) {
        console.error('Error calculating optimal withdrawals:', error);
        return [];
    }
}
