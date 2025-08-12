import * as fs from 'fs';
import { ALLOWED_VALIDATORS } from './constants';
import { calculateExpectedDelegations, getDelegationData, ValidatorBoostData } from './helper';

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

function loadValidatorBoostWeights(): Map<string, ValidatorBoostData> {
    try {
        const csvContent = fs.readFileSync('src/results/validator-delegation-boost.csv', 'utf8');
        const lines = csvContent.trim().split('\n');
        const header = lines[0]; // Skip header

        if (!header.includes('total_sts_amount') || !header.includes('weight')) {
            console.error('Invalid CSV format. Please run track-validator-delegation-boost.ts first.');
            return new Map();
        }

        const boostWeights = new Map<string, ValidatorBoostData>();

        for (let i = 1; i < lines.length; i++) {
            const [validatorId, totalStSAmount, totalSAmount, weight] = lines[i].split(',');

            boostWeights.set(validatorId, {
                validatorId,
                totalStSAmount: parseFloat(totalStSAmount),
                totalSAmount: parseFloat(totalSAmount),
                weight: parseFloat(weight),
            });
        }

        return boostWeights;
    } catch (error) {
        console.error('Error loading validator boost weights:', error);
        console.error('Please run track-validator-delegation-boost.ts first to generate the boost data.');
        return new Map();
    }
}

function calculateWithdrawalsWithPriority(
    notAllowedValidators: ValidatorAnalysis[],
    allowedValidators: ValidatorAnalysis[],
    withdrawalAmount: number,
): WithdrawalRecommendation[] {
    const recommendations: WithdrawalRecommendation[] = [];
    let remainingWithdrawal = withdrawalAmount;

    console.log(`\n🎯 WITHDRAWAL STRATEGY for ${withdrawalAmount.toLocaleString()} S:`);
    console.log('='.repeat(80));

    // PRIORITY 1: Withdraw from not-allowed validators first (withdraw to 0)
    if (notAllowedValidators.length > 0) {
        console.log('\n🚫 PRIORITY 1: Withdrawing from NOT-ALLOWED validators first');
        console.log('-'.repeat(60));

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

                console.log(
                    `🚫 Withdraw ${availableWithdrawal.toLocaleString()} S from NOT-ALLOWED Validator ${
                        validator.validatorId
                    }`,
                );
                console.log(`   Current: ${validator.currentDelegation.toLocaleString()} S → Target: 0 S`);
                console.log(
                    `   Remaining after withdrawal: ${(
                        validator.currentDelegation - availableWithdrawal
                    ).toLocaleString()} S`,
                );
                console.log();
            }
        }
    }

    // PRIORITY 2: If withdrawal amount remains, withdraw from over-delegated allowed validators
    if (remainingWithdrawal > 0.01) {
        console.log('\n🔴 PRIORITY 2: Withdrawing from OVER-DELEGATED allowed validators');
        console.log('-'.repeat(60));

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

                    console.log(
                        `📤 Withdraw ${availableWithdrawal.toLocaleString()} S from Validator ${validator.validatorId}`,
                    );
                    console.log(
                        `   Current: ${validator.currentDelegation.toLocaleString()} S, Expected: ${validator.expectedDelegation.toLocaleString()} S`,
                    );
                    console.log(`   Over-delegated by: ${validator.overDelegated.toLocaleString()} S`);
                    console.log();
                }
            }
        }
    }

    if (remainingWithdrawal > 0.01) {
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
        const boostWeights = loadValidatorBoostWeights();

        if (boostWeights.size === 0) {
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
            (sum, boost) => sum + boost.totalSAmount,
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

        // Calculate withdrawal recommendations - prioritize not-allowed validators first
        const recommendations = calculateWithdrawalsWithPriority(
            notAllowedValidators,
            validatorAnalyses,
            withdrawalAmount,
        );

        console.log('\n📋 SUMMARY:');
        console.log(`Total withdrawal requested: ${withdrawalAmount.toLocaleString()} S`);
        console.log(`Total recommendations: ${recommendations.length}`);
        console.log(
            `Total allocated: ${recommendations.reduce((sum, r) => sum + r.withdrawalAmount, 0).toLocaleString()} S`,
        );

        return recommendations;
    } catch (error) {
        console.error('Error calculating optimal withdrawals:', error);
        return [];
    }
}
