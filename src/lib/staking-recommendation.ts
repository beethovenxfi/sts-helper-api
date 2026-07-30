import { createPublicClient, http, formatUnits, getAddress } from 'viem';
import { sonic } from 'viem/chains';
import { ALLOWED_VALIDATORS, SFC_ADDRESS, BEETS_VALIDATOR_ID } from './constants';
import { getDelegationState } from './helper';

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
        const maxDelegation = selfStakeS * 15; // Max delegation is 15x self-stake
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
    const infos = await Promise.all(validatorIds.map(getValidatorInfo));

    return new Map(infos.filter((info): info is ValidatorInfo => info !== null).map((info) => [info.validatorId, info]));
}

// Export for use in API
export async function getStakingRecommendation() {
    try {
        const { boostData, delegations, allValidatorIds, totalDelegation, totalBoostedDelegation, expectedDelegations } =
            await getDelegationState();

        // Get validator info for all validators
        const validatorInfos = await getValidatorInfos(allValidatorIds);

        // Create analysis results
        const analysisResults: DelegationAnalysis[] = [];

        for (const validatorId of allValidatorIds) {
            const currentDelegation = parseFloat(delegations.get(validatorId) || '0');
            const validatorInfo = validatorInfos.get(validatorId);
            const expectedDelegation =
                validatorId === BEETS_VALIDATOR_ID
                    ? validatorInfo?.maxDelegation || 0
                    : expectedDelegations.get(validatorId) || 0;
            const difference = currentDelegation - expectedDelegation;

            let status: 'over-delegated' | 'under-delegated' | 'balanced' | 'not-allowed';
            if (!ALLOWED_VALIDATORS.includes(validatorId)) {
                status = 'not-allowed';
            } else if (Math.abs(difference) < 1) {
                status = 'balanced';
            } else if (difference > 0) {
                status = 'over-delegated';
            } else {
                status = 'under-delegated';
            }

            // Get validator balance data
            const validatorBalance = boostData.find((v) => v.validatorId === validatorId);

            analysisResults.push({
                validatorId,
                currentDelegation,
                expectedDelegation,
                maxDelegation: validatorInfo?.maxDelegation || 0,
                totalStake: validatorInfo?.receivedStake || 0,
                remainingCapacity: validatorInfo?.remainingCapacity || 0,
                canReceiveDelegation: validatorInfo?.canReceiveDelegation || false,
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
