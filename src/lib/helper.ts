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

export async function loadValidatorBoostData(): Promise<ValidatorBoostData[]> {
    try {
        const csvUrl =
            'https://raw.githubusercontent.com/beethovenxfi/sts-helper-api/refs/heads/main/src/results/validator-delegation-boost.csv';
        console.log(`🔄 Loading validator boost data from: ${csvUrl}`);

        // Fetch CSV data from URL
        const response = await fetch(csvUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch CSV data: ${response.status} ${response.statusText}`);
        }

        const csvText = await response.text();

        // Parse CSV data
        const lines = csvText.trim().split('\n');

        if (lines.length === 0) {
            throw new Error('CSV file is empty');
        }

        // Skip header line and parse data rows
        const headerLine = lines[0];
        console.log(`📊 CSV Header: ${headerLine}`);

        // Validate header format
        const expectedHeader = 'validatorid,total_sts_amount,total_s_amount,weight';
        if (
            !headerLine?.toLowerCase().includes('validatorid') ||
            !headerLine?.toLowerCase().includes('total_sts_amount') ||
            !headerLine?.toLowerCase().includes('weight')
        ) {
            console.warn(`⚠️  Unexpected CSV header format. Expected: ${expectedHeader}, Got: ${headerLine}`);
        }

        const validatorBoostData: ValidatorBoostData[] = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i]?.trim();
            if (!line) continue; // Skip empty lines

            const columns = line.split(',');

            if (columns.length < 4) {
                console.warn(`⚠️  Skipping invalid CSV line ${i + 1}: ${line}`);
                continue;
            }

            try {
                const validatorId = columns[0]?.trim();
                const totalStSBalance = parseFloat(columns[1]?.trim() || '0');
                const totalSBalance = parseFloat(columns[2]?.trim() || '0');
                const weight = parseFloat(columns[3]?.trim() || '0');

                // Validate data
                if (!validatorId) {
                    console.warn(`⚠️  Skipping line ${i + 1}: missing validator ID`);
                    continue;
                }

                if (isNaN(totalStSBalance) || isNaN(totalSBalance) || isNaN(weight)) {
                    console.warn(`⚠️  Skipping line ${i + 1}: invalid numeric values`);
                    continue;
                }

                validatorBoostData.push({
                    validatorId,
                    totalStSBalance,
                    totalSBalance,
                    weight,
                });
            } catch (error) {
                console.warn(`⚠️  Error parsing line ${i + 1}: ${line}`, error);
                continue;
            }
        }

        console.log(`✅ Successfully loaded ${validatorBoostData.length} validator boost records`);

        // Log summary
        if (validatorBoostData.length > 0) {
            const totalWeight = validatorBoostData.reduce((sum, data) => sum + data.weight, 0);
            console.log(`📊 Total weight: ${totalWeight.toFixed(2)}%`);
            console.log(`🎯 Validator IDs: ${validatorBoostData.map((d) => d.validatorId).join(', ')}`);
        }

        return validatorBoostData;
    } catch (error) {
        console.error('❌ Error loading validator boost data:', error);
        throw new Error(
            `Failed to load validator boost data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
    }
}
