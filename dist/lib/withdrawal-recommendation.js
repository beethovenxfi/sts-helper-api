"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateOptimalWithdrawals = calculateOptimalWithdrawals;
const constants_1 = require("./constants");
const helper_1 = require("./helper");
const utils_1 = require("viem/utils");
function calculateWithdrawalsWithPriority(notAllowedValidators, allowedValidators, withdrawalAmount) {
    const recommendations = [];
    let remainingWithdrawal = withdrawalAmount;
    // PRIORITY 1: Withdraw from not-allowed validators first (withdraw to 0)
    if (notAllowedValidators.length > 0) {
        // Sort by highest delegation first to prioritize biggest withdrawals
        const sortedNotAllowed = notAllowedValidators.sort((a, b) => parseFloat((0, utils_1.formatEther)(b.currentDelegation)) - parseFloat((0, utils_1.formatEther)(a.currentDelegation)));
        for (const validator of sortedNotAllowed) {
            if (remainingWithdrawal <= 0n)
                break;
            // Withdraw all delegation from not-allowed validators (or remaining withdrawal amount)
            const availableWithdrawal = remainingWithdrawal > validator.currentDelegation ? validator.currentDelegation : remainingWithdrawal;
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
            .sort((a, b) => parseFloat((0, utils_1.formatEther)(b.overDelegated)) - parseFloat((0, utils_1.formatEther)(a.overDelegated)));
        if (overDelegatedValidators.length === 0) {
            console.log('⚠️  No over-delegated allowed validators found for remaining withdrawal.');
        }
        else {
            for (const validator of overDelegatedValidators) {
                if (remainingWithdrawal <= 0)
                    break;
                // Calculate how much can be withdrawn from this validator
                const availableWithdrawal = remainingWithdrawal > validator.overDelegated ? validator.overDelegated : remainingWithdrawal;
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
        const allValidatorsSorted = allowedValidators.sort((a, b) => parseFloat((0, utils_1.formatEther)(b.currentDelegation)) - parseFloat((0, utils_1.formatEther)(a.currentDelegation)));
        for (const validator of allValidatorsSorted) {
            if (remainingWithdrawal <= 0)
                break;
            // Calculate how much can be withdrawn from this validator
            const availableWithdrawal = remainingWithdrawal > validator.currentDelegation ? validator.currentDelegation : remainingWithdrawal;
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
        console.warn(`⚠️  Unable to withdraw the full amount of ${(0, utils_1.formatEther)(withdrawalAmount)} S. Remaining: ${(0, utils_1.formatEther)(remainingWithdrawal)} S`);
        throw new Error(`Unable to withdraw the full amount of ${(0, utils_1.formatEther)(withdrawalAmount)} S. Remaining: ${(0, utils_1.formatEther)(remainingWithdrawal)} S`);
    }
    // double check that all recommendations add up to the requested withdrawal amount
    const totalWithdrawal = recommendations.reduce((sum, rec) => sum + BigInt(rec.withdrawalAmount), 0n);
    if (totalWithdrawal !== withdrawalAmount) {
        throw new Error(`Total withdrawal amount ${(0, utils_1.formatEther)(totalWithdrawal)} S does not match requested amount ${(0, utils_1.formatEther)(withdrawalAmount)} S`);
    }
    return recommendations;
}
async function calculateOptimalWithdrawals(withdrawalAmount) {
    try {
        // Load validator boost weights
        const boostWeights = await (0, helper_1.loadValidatorBoostData)();
        if (boostWeights.length === 0) {
            console.log('❌ No boost weight data found. Please run track-validator-delegation-boost.ts first.');
            return [];
        }
        // Get delegation data
        const delegationData = await (0, helper_1.getDelegationData)();
        if (delegationData.length === 0) {
            console.log('❌ No delegation data found.');
            return [];
        }
        // Calculate total delegation
        const totalDelegation = delegationData.reduce((sum, d) => sum + parseFloat(d.assetsDelegated), 0);
        const totalBoostedDelegation = Array.from(boostWeights.values()).reduce((sum, boost) => sum + boost.totalSBalance, 0);
        // Calculate expected delegations using boost weights
        const allDelegationValidators = delegationData.map((d) => d.validatorId);
        const expectedDelegations = (0, helper_1.calculateExpectedDelegations)(boostWeights, totalDelegation, totalBoostedDelegation, allDelegationValidators);
        // Analyze each validator - including not-allowed ones for withdrawal
        const validatorAnalyses = [];
        const notAllowedValidators = [];
        for (const delegation of delegationData) {
            const currentDelegation = (0, utils_1.parseEther)(delegation.assetsDelegated);
            if (!constants_1.ALLOWED_VALIDATORS.includes(delegation.validatorId)) {
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
            const expectedDelegation = (0, utils_1.parseEther)(expectedDelegations.get(delegation.validatorId)?.toString() || '0');
            const difference = currentDelegation - expectedDelegation;
            const isOverDelegated = difference > (0, utils_1.parseEther)('1'); // Consider over-delegated if difference > 1 S
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
        const recommendations = calculateWithdrawalsWithPriority(notAllowedValidators, validatorAnalyses, withdrawalAmount);
        return recommendations;
    }
    catch (error) {
        console.error('Error calculating optimal withdrawals:', error);
        return [];
    }
}
