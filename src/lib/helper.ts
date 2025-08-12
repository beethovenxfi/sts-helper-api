import { ALLOWED_VALIDATORS, API_URL } from './constants';

export interface DelegatedValidator {
    validatorId: string;
    assetsDelegated: string;
}

export interface SummaryData {
    totalStSAmount: number;
    totalSAmount: number;
    assetsTracked: string[];
}

export interface ValidatorBoostData {
    validatorId: string;
    totalStSBalance: number;
    totalSBalance: number;
    weight: number;
    isGrouped: boolean;
    groupId?: number;
}

export async function getDelegationData(): Promise<DelegatedValidator[]> {
    const query = `{
        stsGetGqlStakedSonicData {
            delegatedValidators {
                validatorId
                assetsDelegated
            }
        }
    }`;

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query }),
        });

        const data = (await response.json()) as {
            data: {
                stsGetGqlStakedSonicData: {
                    delegatedValidators: DelegatedValidator[];
                };
            };
        };

        if (!data?.data?.stsGetGqlStakedSonicData?.delegatedValidators) {
            console.error('Invalid delegation data response');
            return [];
        }

        return data.data.stsGetGqlStakedSonicData.delegatedValidators;
    } catch (error) {
        console.error('Error fetching delegation data:', error);
        return [];
    }
}

export function calculateExpectedDelegations(
    validatorBoostData: ValidatorBoostData[],
    totalDelegation: number,
    totalBoostedDelegation: number,
    allDelegationValidators: string[],
): Map<string, number> {
    // Filter to only allowed validators for receiving delegation
    const allowedValidators = allDelegationValidators.filter((id) => ALLOWED_VALIDATORS.includes(id));

    const totalValidators = allowedValidators.length;
    const evenlyDistributedAmount = (totalDelegation - totalBoostedDelegation) / 2;
    const boostedDistributedAmount = evenlyDistributedAmount + totalBoostedDelegation;

    // Half split evenly across ALLOWED validators only
    const evenShare = evenlyDistributedAmount / totalValidators;

    const expectedDelegations = new Map<string, number>();

    // Initialize ALL validators (including not-allowed ones) with 0
    for (const validatorId of allDelegationValidators) {
        expectedDelegations.set(validatorId, 0);
    }

    // Set even share for allowed validators only
    for (const validatorId of allowedValidators) {
        expectedDelegations.set(validatorId, evenShare);
    }

    // Add weighted share based on boost weights for allowed validators only
    for (const validatorId of allowedValidators) {
        const boostData = validatorBoostData.find((data) => data.validatorId === validatorId);
        if (boostData && boostData.weight > 0) {
            // Convert weight percentage to decimal and apply to half delegation
            const weightedShare = (boostData.weight / 100) * boostedDistributedAmount;
            const currentExpected = expectedDelegations.get(validatorId) || evenShare;
            expectedDelegations.set(validatorId, currentExpected + weightedShare);
        }
    }

    return expectedDelegations;
}
