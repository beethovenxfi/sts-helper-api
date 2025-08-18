"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDelegationData = getDelegationData;
exports.calculateExpectedDelegations = calculateExpectedDelegations;
exports.loadValidatorBoostData = loadValidatorBoostData;
const constants_1 = require("./constants");
async function getDelegationData() {
    const query = `{
        stsGetGqlStakedSonicData {
            delegatedValidators {
                validatorId
                assetsDelegated
            }
        }
    }`;
    try {
        const response = await fetch(constants_1.API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query }),
        });
        const data = (await response.json());
        if (!data?.data?.stsGetGqlStakedSonicData?.delegatedValidators) {
            console.error('Invalid delegation data response');
            return [];
        }
        return data.data.stsGetGqlStakedSonicData.delegatedValidators;
    }
    catch (error) {
        console.error('Error fetching delegation data:', error);
        return [];
    }
}
function calculateExpectedDelegations(validatorBoostData, totalDelegation, totalBoostedDelegation, allDelegationValidators) {
    // Filter to only allowed validators for receiving delegation
    const allowedValidators = allDelegationValidators.filter((id) => constants_1.ALLOWED_VALIDATORS.includes(id));
    const totalValidators = allowedValidators.length;
    const evenlyDistributedAmount = (totalDelegation - totalBoostedDelegation) / 2;
    const boostedDistributedAmount = evenlyDistributedAmount + totalBoostedDelegation;
    // Half split evenly across ALLOWED validators only
    const evenShare = evenlyDistributedAmount / totalValidators;
    const expectedDelegations = new Map();
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
async function loadValidatorBoostData() {
    try {
        const csvUrl = 'https://raw.githubusercontent.com/beethovenxfi/sts-helper-api/refs/heads/main/src/results/validator-delegation-boost.csv';
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
        // Validate header format
        const expectedHeader = 'validatorid,total_sts_amount,total_s_amount,weight';
        if (!headerLine?.toLowerCase().includes('validatorid') ||
            !headerLine?.toLowerCase().includes('total_sts_amount') ||
            !headerLine?.toLowerCase().includes('weight')) {
            console.warn(`⚠️  Unexpected CSV header format. Expected: ${expectedHeader}, Got: ${headerLine}`);
        }
        const validatorBoostData = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i]?.trim();
            if (!line)
                continue; // Skip empty lines
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
            }
            catch (error) {
                console.warn(`⚠️  Error parsing line ${i + 1}: ${line}`, error);
                continue;
            }
        }
        return validatorBoostData;
    }
    catch (error) {
        console.error('❌ Error loading validator boost data:', error);
        throw new Error(`Failed to load validator boost data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
