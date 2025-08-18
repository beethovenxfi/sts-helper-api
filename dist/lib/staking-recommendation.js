"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStakingRecommendation = getStakingRecommendation;
const viem_1 = require("viem");
const chains_1 = require("viem/chains");
const constants_1 = require("./constants");
const helper_1 = require("./helper");
// SFC (Staker Faucet Contract) address for Sonic chain
// Create viem client for Sonic chain
const client = (0, viem_1.createPublicClient)({
    chain: chains_1.sonic,
    transport: (0, viem_1.http)(),
});
// SFC ABI for getSelfStake and getValidator functions
const SFC_ABI = [
    {
        inputs: [{ internalType: 'uint256', name: 'validatorID', type: 'uint256' }],
        name: 'getSelfStake',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ internalType: 'uint256', name: 'validatorID', type: 'uint256' }],
        name: 'getValidator',
        outputs: [
            { internalType: 'uint256', name: 'status', type: 'uint256' },
            { internalType: 'uint256', name: 'receivedStake', type: 'uint256' },
            { internalType: 'address', name: 'auth', type: 'address' },
            { internalType: 'uint256', name: 'createdEpoch', type: 'uint256' },
            { internalType: 'uint256', name: 'createdTime', type: 'uint256' },
            { internalType: 'uint256', name: 'deactivatedTime', type: 'uint256' },
            { internalType: 'uint256', name: 'deactivatedEpoch', type: 'uint256' },
        ],
        stateMutability: 'view',
        type: 'function',
    },
];
async function getValidatorInfo(validatorId) {
    try {
        const [selfStake, validatorData] = await Promise.all([
            client.readContract({
                address: (0, viem_1.getAddress)(constants_1.SFC_ADDRESS),
                abi: SFC_ABI,
                functionName: 'getSelfStake',
                args: [BigInt(validatorId)],
            }),
            client.readContract({
                address: (0, viem_1.getAddress)(constants_1.SFC_ADDRESS),
                abi: SFC_ABI,
                functionName: 'getValidator',
                args: [BigInt(validatorId)],
            }),
        ]);
        const selfStakeS = parseFloat((0, viem_1.formatUnits)(selfStake, 18));
        const validatorInfo = validatorData;
        const [status, receivedStake, auth, createdEpoch, createdTime, deactivatedTime, deactivatedEpoch] = validatorInfo;
        const receivedStakeS = parseFloat((0, viem_1.formatUnits)(receivedStake, 18));
        const maxDelegation = selfStakeS * 16;
        const remainingCapacity = Math.max(0, maxDelegation - receivedStakeS);
        const canReceiveDelegation = remainingCapacity >= 500000 && Number(status) === 0; // Status 0 = active AND at least 500k capacity
        return {
            validatorId,
            status: Number(status),
            receivedStake: receivedStakeS,
            selfStake: selfStakeS,
            maxDelegation,
            remainingCapacity,
            canReceiveDelegation,
        };
    }
    catch (error) {
        console.error(`Error getting validator info for validator ${validatorId}:`, error);
        return null;
    }
}
async function getValidatorInfos(validatorIds) {
    const validatorInfos = new Map();
    for (const validatorId of validatorIds) {
        const info = await getValidatorInfo(validatorId);
        if (info) {
            validatorInfos.set(validatorId, info);
        }
    }
    return validatorInfos;
}
// Export for use in API
async function getStakingRecommendation() {
    try {
        const validatorData = await (0, helper_1.loadValidatorBoostData)();
        // Get delegation data
        const delegationData = await (0, helper_1.getDelegationData)();
        if (delegationData.length === 0) {
            throw new Error('No delegation data found.');
        }
        // Calculate total delegation
        const totalDelegation = delegationData.reduce((sum, d) => sum + parseFloat(d.assetsDelegated), 0);
        const totalBoostedDelegation = Array.from(validatorData.values()).reduce((sum, boost) => sum + boost.totalSBalance, 0);
        // Calculate expected delegations using boost weights
        const allDelegationValidators = delegationData.map((d) => d.validatorId);
        const expectedDelegations = (0, helper_1.calculateExpectedDelegations)(validatorData, totalDelegation, totalBoostedDelegation, allDelegationValidators);
        // Get validator info for all validators
        const validatorInfos = await getValidatorInfos(allDelegationValidators);
        // Create analysis results
        const analysisResults = [];
        for (const delegation of delegationData) {
            const currentDelegation = parseFloat(delegation.assetsDelegated);
            const expectedDelegation = expectedDelegations.get(delegation.validatorId) || 0;
            const validatorInfo = validatorInfos.get(delegation.validatorId);
            const maxDelegation = validatorInfo?.maxDelegation || 0;
            const totalStake = validatorInfo?.receivedStake || 0;
            const remainingCapacity = validatorInfo?.remainingCapacity || 0;
            const canReceiveDelegation = validatorInfo?.canReceiveDelegation || false;
            const difference = currentDelegation - expectedDelegation;
            let status;
            if (!constants_1.ALLOWED_VALIDATORS.includes(delegation.validatorId)) {
                status = 'not-allowed';
            }
            else if (Math.abs(difference) < 1) {
                status = 'balanced';
            }
            else if (difference > 0) {
                status = 'over-delegated';
            }
            else {
                status = 'under-delegated';
            }
            // Get validator balance data
            const validatorBalance = validatorData.find((v) => v.validatorId === delegation.validatorId);
            analysisResults.push({
                validatorId: delegation.validatorId,
                currentDelegation,
                expectedDelegation,
                maxDelegation,
                totalStake,
                remainingCapacity,
                canReceiveDelegation,
                difference,
                status,
                // Additional fields for API response
                sBalance: validatorBalance?.totalSBalance || 0,
                boostWeight: validatorBalance?.weight || 0,
                stsBalance: validatorBalance?.totalStSBalance || 0,
            });
        }
        // Sort by difference (most over-delegated first)
        analysisResults.sort((a, b) => b.difference - a.difference);
        // Categorize results
        const overDelegated = analysisResults.filter((r) => r.status === 'over-delegated');
        const underDelegated = analysisResults.filter((r) => r.status === 'under-delegated');
        const balanced = analysisResults.filter((r) => r.status === 'balanced');
        const notAllowed = analysisResults.filter((r) => r.status === 'not-allowed');
        return {
            summary: {
                totalDelegation,
                totalBoostedDelegation,
                allowedValidators: constants_1.ALLOWED_VALIDATORS,
                validatorCounts: {
                    overDelegated: overDelegated.length,
                    underDelegated: underDelegated.length,
                    balanced: balanced.length,
                    notAllowed: notAllowed.length,
                    total: analysisResults.length,
                },
            },
            validators: {
                overDelegated,
                underDelegated,
                balanced,
                notAllowed,
            },
            allValidators: analysisResults,
        };
    }
    catch (error) {
        console.error('Error analyzing delegations:', error);
        throw error;
    }
}
