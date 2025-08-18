import * as fs from 'fs';
import { ALLOWED_VALIDATORS } from './constants';
import { calculateExpectedDelegations, getDelegationData, loadValidatorBoostData, ValidatorBoostData } from './helper';
import { formatEther, parseEther } from 'viem/utils';

interface WithdrawalRecommendation {
    withdrawalAmount: string;
    validatorId: string;
}

interface ValidatorAnalysis {
    validatorId: string;
    currentDelegation: bigint;
    expectedDelegation: bigint;
    overDelegated: bigint;
    isOverDelegated: boolean;
}

function calculateWithdrawalsWithPriority(
    notAllowedValidators: ValidatorAnalysis[],
    allowedValidators: ValidatorAnalysis[],
    withdrawalAmount: bigint,
): WithdrawalRecommendation[] {
    const recommendations: WithdrawalRecommendation[] = [];
    let remainingWithdrawal = withdrawalAmount;

    // PRIORITY 1: Withdraw from not-allowed validators first (withdraw to 0)
    if (notAllowedValidators.length > 0) {
        // Sort by highest delegation first to prioritize biggest withdrawals
        const sortedNotAllowed = notAllowedValidators.sort(
            (a, b) => parseFloat(formatEther(b.currentDelegation)) - parseFloat(formatEther(a.currentDelegation)),
        );

        for (const validator of sortedNotAllowed) {
            if (remainingWithdrawal <= 0n) break;

            // Withdraw all delegation from not-allowed validators (or remaining withdrawal amount)
            const availableWithdrawal =
                remainingWithdrawal > validator.currentDelegation ? validator.currentDelegation : remainingWithdrawal;

            if (availableWithdrawal > 0n) {
                recommendations.push({
                    withdrawalAmount: availableWithdrawal.toString(),
                    validatorId: validator.validatorId,
                });

                remainingWithdrawal -= availableWithdrawal;
            }
        }
    }

    // PRIORITY 2: If withdrawal amount remains, withdraw from over-delegated allowed validators
    if (remainingWithdrawal > 0n) {
        // Filter to only over-delegated validators and sort by highest over-delegation first
        const overDelegatedValidators = allowedValidators
            .filter((v) => v.isOverDelegated && v.overDelegated > 1)
            .sort((a, b) => parseFloat(formatEther(b.overDelegated)) - parseFloat(formatEther(a.overDelegated)));

        if (overDelegatedValidators.length === 0) {
            console.log('⚠️  No over-delegated allowed validators found for remaining withdrawal.');
        } else {
            for (const validator of overDelegatedValidators) {
                if (remainingWithdrawal <= 0) break;

                // Calculate how much can be withdrawn from this validator
                const availableWithdrawal =
                    remainingWithdrawal > validator.overDelegated ? validator.overDelegated : remainingWithdrawal;

                if (availableWithdrawal > 0n) {
                    recommendations.push({
                        withdrawalAmount: availableWithdrawal.toString(),
                        validatorId: validator.validatorId,
                    });

                    remainingWithdrawal -= availableWithdrawal;
                }
            }
        }
    }

    // PRIORITY 3: If still remaining, withdraw from allowed validators with biggest available capacity first
    if (remainingWithdrawal > 0n) {
        // Filter to only over-delegated validators and sort by highest over-delegation first
        const allValidatorsSorted = allowedValidators.sort(
            (a, b) => parseFloat(formatEther(b.currentDelegation)) - parseFloat(formatEther(a.currentDelegation)),
        );

        for (const validator of allValidatorsSorted) {
            if (remainingWithdrawal <= 0) break;

            // Calculate how much can be withdrawn from this validator
            const availableWithdrawal =
                remainingWithdrawal > validator.currentDelegation ? validator.currentDelegation : remainingWithdrawal;

            if (availableWithdrawal > 0n) {
                recommendations.push({
                    withdrawalAmount: availableWithdrawal.toString(),
                    validatorId: validator.validatorId,
                });

                remainingWithdrawal -= availableWithdrawal;
            }
        }
    }

    // If still remaining, log a warning and return empty recommendations
    if (remainingWithdrawal > 0n) {
        console.warn(
            `⚠️  Unable to withdraw the full amount of ${formatEther(withdrawalAmount)} S. Remaining: ${formatEther(
                remainingWithdrawal,
            )} S`,
        );
        throw new Error(
            `Unable to withdraw the full amount of ${formatEther(withdrawalAmount)} S. Remaining: ${formatEther(
                remainingWithdrawal,
            )} S`,
        );
    }

    // double check that all recommendations add up to the requested withdrawal amount
    const totalWithdrawal = recommendations.reduce((sum, rec) => sum + BigInt(rec.withdrawalAmount), 0n);
    if (totalWithdrawal !== withdrawalAmount) {
        throw new Error(
            `Total withdrawal amount ${formatEther(totalWithdrawal)} S does not match requested amount ${formatEther(
                withdrawalAmount,
            )} S`,
        );
    }

    return recommendations;
}

export async function calculateOptimalWithdrawals(withdrawalAmount: bigint): Promise<WithdrawalRecommendation[]> {
    try {
        // Load validator boost weights
        const boostWeights = await loadValidatorBoostData();

        if (boostWeights.length === 0) {
            throw new Error('No boost weight data found.');
        }

        // Get delegation data
        const delegationData = await getDelegationData();

        if (delegationData.length === 0) {
            throw new Error('No delegation data found.');
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
            const currentDelegation = parseEther(delegation.assetsDelegated);

            if (!ALLOWED_VALIDATORS.includes(delegation.validatorId)) {
                // Not-allowed validators should be withdrawn to 0
                if (currentDelegation > 0n) {
                    // Include ALL delegations from not-allowed validators, even tiny amounts
                    notAllowedValidators.push({
                        validatorId: delegation.validatorId,
                        currentDelegation,
                        expectedDelegation: 0n, // Should be 0
                        overDelegated: currentDelegation, // All delegation is over-delegation
                        isOverDelegated: true,
                    });
                }
                continue;
            }

            const expectedDelegation = parseEther(expectedDelegations.get(delegation.validatorId)?.toString() || '0');
            const difference = currentDelegation - expectedDelegation;
            const isOverDelegated = difference > parseEther('1'); // Consider over-delegated if difference > 1 S

            validatorAnalyses.push({
                validatorId: delegation.validatorId,
                currentDelegation,
                expectedDelegation,
                overDelegated: isOverDelegated ? difference : 0n,
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
