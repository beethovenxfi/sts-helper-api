import * as fs from 'fs';
import { createPublicClient, http, formatUnits, getAddress } from 'viem';
import { sonic } from 'viem/chains';
import { API_URL, ALLOWED_VALIDATORS, SFC_ADDRESS } from './constants';
import { calculateExpectedDelegations, getDelegationData, loadValidatorBoostData, ValidatorBoostData } from './helper';

// SFC (Staker Faucet Contract) address for Sonic chain

// Create viem client for Sonic chain
const client = createPublicClient({
    chain: sonic,
    transport: http(),
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

interface ValidatorBalance {
    validatorId: string;
    totalStSBalance: number;
    totalSBalance: number;
    weight: number;
}

interface ValidatorInfo {
    validatorId: string;
    status: number;
    receivedStake: number; // Total stake including delegations
    selfStake: number;
    maxDelegation: number;
    remainingCapacity: number;
    canReceiveDelegation: boolean;
}

interface DelegationAnalysis {
    validatorId: string;
    currentDelegation: number;
    expectedDelegation: number;
    maxDelegation: number;
    totalStake: number;
    remainingCapacity: number;
    canReceiveDelegation: boolean;
    difference: number;
    status: 'over-delegated' | 'under-delegated' | 'balanced' | 'not-allowed';
    sBalance?: number;
    boostWeight?: number;
    stsBalance?: number;
}

async function getValidatorInfo(validatorId: string): Promise<ValidatorInfo | null> {
    try {
        const [selfStake, validatorData] = await Promise.all([
            client.readContract({
                address: getAddress(SFC_ADDRESS),
                abi: SFC_ABI,
                functionName: 'getSelfStake',
                args: [BigInt(validatorId)],
            }),
            client.readContract({
                address: getAddress(SFC_ADDRESS),
                abi: SFC_ABI,
                functionName: 'getValidator',
                args: [BigInt(validatorId)],
            }),
        ]);

        const selfStakeS = parseFloat(formatUnits(selfStake as bigint, 18));
        const validatorInfo = validatorData as [bigint, bigint, string, bigint, bigint, bigint, bigint];
        const [status, receivedStake, auth, createdEpoch, createdTime, deactivatedTime, deactivatedEpoch] =
            validatorInfo;

        const receivedStakeS = parseFloat(formatUnits(receivedStake, 18));
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
    } catch (error) {
        console.error(`Error getting validator info for validator ${validatorId}:`, error);
        return null;
    }
}

async function getValidatorInfos(validatorIds: string[]): Promise<Map<string, ValidatorInfo>> {
    const validatorInfos = new Map<string, ValidatorInfo>();

    for (const validatorId of validatorIds) {
        const info = await getValidatorInfo(validatorId);

        if (info) {
            validatorInfos.set(validatorId, info);
        }
    }

    return validatorInfos;
}

// Export for use in API
export async function getValidatorAnalysisData() {
    try {
        const validatorData = await loadValidatorBoostData();
        // Get delegation data
        const delegationData = await getDelegationData();

        if (delegationData.length === 0) {
            throw new Error('No delegation data found.');
        }

        // Calculate total delegation
        const totalDelegation = delegationData.reduce((sum, d) => sum + parseFloat(d.assetsDelegated), 0);

        const totalBoostedDelegation = Array.from(validatorData.values()).reduce(
            (sum, boost) => sum + boost.totalSBalance,
            0,
        );

        // Calculate expected delegations using boost weights

        const allDelegationValidators = delegationData.map((d) => d.validatorId);
        const expectedDelegations = calculateExpectedDelegations(
            validatorData,
            totalDelegation,
            totalBoostedDelegation,
            allDelegationValidators,
        );

        // Get validator info for all validators
        const validatorInfos = await getValidatorInfos(allDelegationValidators);

        // Create analysis results
        const analysisResults: DelegationAnalysis[] = [];

        for (const delegation of delegationData) {
            const currentDelegation = parseFloat(delegation.assetsDelegated);
            const expectedDelegation = expectedDelegations.get(delegation.validatorId) || 0;
            const validatorInfo = validatorInfos.get(delegation.validatorId);
            const maxDelegation = validatorInfo?.maxDelegation || 0;
            const totalStake = validatorInfo?.receivedStake || 0;
            const remainingCapacity = validatorInfo?.remainingCapacity || 0;
            const canReceiveDelegation = validatorInfo?.canReceiveDelegation || false;
            const difference = currentDelegation - expectedDelegation;

            let status: 'over-delegated' | 'under-delegated' | 'balanced' | 'not-allowed';
            if (!ALLOWED_VALIDATORS.includes(delegation.validatorId)) {
                status = 'not-allowed';
            } else if (Math.abs(difference) < 1) {
                status = 'balanced';
            } else if (difference > 0) {
                status = 'over-delegated';
            } else {
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
                allowedValidators: ALLOWED_VALIDATORS,
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
    } catch (error) {
        console.error('Error analyzing delegations:', error);
        throw error;
    }
}
