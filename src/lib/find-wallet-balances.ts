import * as core from '@actions/core';
import { createPublicClient, http, formatUnits, getAddress, parseEther, formatEther } from 'viem';
import { sonic } from 'viem/chains';
import * as fs from 'fs';
import { API_URL, stSAddress } from './constants';
import { ValidatorBoostData } from './helper';

const TRACKED_TOKENS = [
    '0xeaa74d7f42267eb907092af4bc700f667eed0b8b', // asonstS
    '0x396922EF30Cf012973343f7174db850c7D265278', // bstS-3
];

const STS_ADDRESS = stSAddress;

// Define validator groups that share wallet balances
const VALIDATOR_GROUPS = [
    ['15', '16', '17', '18'], // Group 1: validators 15, 16, 17, 18
    ['13', '14'], // Group 2: validators 13, 14
];

const client = createPublicClient({
    chain: sonic,
    transport: http(),
});

const ERC20_ABI = [
    {
        constant: true,
        inputs: [{ name: '_owner', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: 'balance', type: 'uint256' }],
        type: 'function',
    },
    {
        constant: true,
        inputs: [],
        name: 'decimals',
        outputs: [{ name: '', type: 'uint8' }],
        type: 'function',
    },
    {
        constant: true,
        inputs: [],
        name: 'symbol',
        outputs: [{ name: '', type: 'string' }],
        type: 'function',
    },
];

const STS_ABI = [
    {
        constant: true,
        inputs: [],
        name: 'getRate',
        outputs: [{ name: '', type: 'uint256' }],
        type: 'function',
    },
];

interface ValidatorMapping {
    [validatorId: string]: string[];
}

interface PoolToken {
    address: string;
    balance: string;
}

interface PoolData {
    poolTokens: PoolToken[];
    dynamicData: {
        totalShares: string;
    };
    userBalance: {
        totalBalance: string;
    };
}

async function getTokenInfo(tokenAddress: string) {
    try {
        const [symbol, decimals] = await Promise.all([
            client.readContract({
                address: getAddress(tokenAddress),
                abi: ERC20_ABI,
                functionName: 'symbol',
            }),
            client.readContract({
                address: getAddress(tokenAddress),
                abi: ERC20_ABI,
                functionName: 'decimals',
            }),
        ]);
        return { symbol, decimals };
    } catch (error) {
        console.error(`Error getting token info for ${tokenAddress}:`, error);
        return { symbol: 'UNKNOWN', decimals: 18 };
    }
}

async function getTokenBalance(tokenAddress: string, walletAddress: string) {
    try {
        const balance = await client.readContract({
            address: getAddress(tokenAddress),
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [getAddress(walletAddress)],
        });
        return balance;
    } catch (error) {
        console.error(`Error getting balance for token ${tokenAddress} and wallet ${walletAddress}:`, error);
        return 0n;
    }
}

async function getStSRate(): Promise<number> {
    try {
        const rate = await client.readContract({
            address: getAddress(STS_ADDRESS),
            abi: STS_ABI,
            functionName: 'getRate',
        });
        // Rate is returned as a uint256, convert to decimal (assuming 18 decimals)
        return parseFloat(formatUnits(rate as bigint, 18));
    } catch (error) {
        console.error('Error getting stS rate:', error);
        return 1; // Default to 1:1 rate if there's an error
    }
}

async function getPoolDataForUser(userAddress: string): Promise<PoolData[]> {
    const query = `query {
        poolGetPools(where:{ chainIn:[SONIC], userAddress:"${userAddress}"}){
            poolTokens{
                address
                balance
            }
            dynamicData{ 
                totalShares
            }
            userBalance{
                totalBalance
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

        const data = (await response.json()) as { data: { poolGetPools: PoolData[] } };

        if (!data?.data?.poolGetPools) {
            return [];
        }

        return data.data.poolGetPools;
    } catch (error) {
        console.error(`Error fetching pool data for ${userAddress}:`, error);
        return [];
    }
}

async function run(): Promise<void> {
    try {
        const validatorMappingEnv = process.env.VALIDATOR_MAPPING;

        if (!validatorMappingEnv) {
            throw new Error('VALIDATOR_MAPPING environment variable is required');
        }

        // Parse from environment variable (JSON string)
        const validatorMapping = JSON.parse(validatorMappingEnv) as ValidatorMapping;

        const allTokens = [...TRACKED_TOKENS, STS_ADDRESS];

        const tokenInfoPromises = allTokens.map((token) => getTokenInfo(token));
        const tokenInfos = await Promise.all(tokenInfoPromises);

        const tokenInfoMap = new Map(allTokens.map((token, index) => [token, tokenInfos[index]])); // Array to store validator balances and sources
        const validatorBalances = new Map<string, number>();
        const validatorSources = new Map<
            string,
            {
                directTokens: { [symbol: string]: number };
                poolBalances: number;
                totalWallets: number;
                isGrouped: boolean;
                groupMembers?: string[];
            }
        >();

        // Get stS conversion rate
        const stsRate = await getStSRate();

        // First pass: collect all balances per validator
        for (const [validatorId, wallets] of Object.entries(validatorMapping)) {
            let validatorTotalStS = 0;
            let totalDirectTokens: { [symbol: string]: number } = {};
            let totalPoolBalances = 0;

            for (const wallet of wallets) {
                // Get direct token balances
                const balancePromises = allTokens.map((token) => getTokenBalance(token, wallet));
                const balances = await Promise.all(balancePromises);

                // Calculate total balance (combine all tokens as they should be added to stS balance)
                let totalCombinedBalance = 0;

                for (let i = 0; i < allTokens.length; i++) {
                    const token = allTokens[i]!;
                    const balance = balances[i] as bigint;
                    const tokenInfo = tokenInfoMap.get(token);

                    if (tokenInfo) {
                        const formattedBalance = formatUnits(balance, tokenInfo.decimals as number);
                        const balanceNum = parseFloat(formattedBalance);
                        totalCombinedBalance += balanceNum;

                        const symbol = tokenInfo.symbol as string;
                        if (!totalDirectTokens[symbol]) totalDirectTokens[symbol] = 0;
                        totalDirectTokens[symbol] += balanceNum;
                    }
                }

                // Get pool balances for stS token
                try {
                    const poolData = await getPoolDataForUser(wallet);
                    let totalStSInPools = 0;

                    for (const pool of poolData) {
                        const stsToken = pool.poolTokens.find(
                            (token) => token.address.toLowerCase() === STS_ADDRESS.toLowerCase(),
                        );

                        if (stsToken && pool.dynamicData.totalShares && pool.userBalance.totalBalance) {
                            const userShare =
                                parseFloat(pool.userBalance.totalBalance) / parseFloat(pool.dynamicData.totalShares);
                            const userStSAmount = parseFloat(stsToken.balance) * userShare;
                            totalStSInPools += userStSAmount;
                        }
                    }

                    totalCombinedBalance += totalStSInPools;
                    totalPoolBalances += totalStSInPools;
                } catch (error) {
                    console.error(`Error fetching pool data for ${wallet}:`, error);
                }

                validatorTotalStS += totalCombinedBalance;
            }

            validatorBalances.set(validatorId, validatorTotalStS);
            validatorSources.set(validatorId, {
                directTokens: totalDirectTokens,
                poolBalances: totalPoolBalances,
                totalWallets: wallets.length,
                isGrouped: false,
            });
        }
        const groupBalances = new Map<number, number>();

        // Calculate total balances for each group
        VALIDATOR_GROUPS.forEach((group, groupId) => {
            let groupTotalStS = 0;

            group.forEach((validatorId) => {
                const balance = validatorBalances.get(validatorId) || 0;
                groupTotalStS += balance;
            });

            groupBalances.set(groupId, groupTotalStS);
        });

        // Distribute group balances evenly among group members and update sources
        VALIDATOR_GROUPS.forEach((group, groupId) => {
            const groupBalance = groupBalances.get(groupId) || 0;
            const avgBalance = groupBalance / group.length;

            // Collect combined sources for the group
            let combinedDirectTokens: { [symbol: string]: number } = {};
            let combinedPoolBalances = 0;
            let totalWallets = 0;

            group.forEach((validatorId) => {
                const sources = validatorSources.get(validatorId);
                if (sources) {
                    Object.entries(sources.directTokens).forEach(([symbol, amount]) => {
                        if (!combinedDirectTokens[symbol]) combinedDirectTokens[symbol] = 0;
                        combinedDirectTokens[symbol] += amount;
                    });
                    combinedPoolBalances += sources.poolBalances;
                    totalWallets += sources.totalWallets;
                }
            });

            // Distribute evenly among group members
            const avgDirectTokens: { [symbol: string]: number } = {};
            Object.entries(combinedDirectTokens).forEach(([symbol, amount]) => {
                avgDirectTokens[symbol] = amount / group.length;
            });

            group.forEach((validatorId) => {
                validatorBalances.set(validatorId, avgBalance);
                validatorSources.set(validatorId, {
                    directTokens: avgDirectTokens,
                    poolBalances: combinedPoolBalances / group.length,
                    totalWallets: Math.round(totalWallets / group.length),
                    isGrouped: true,
                    groupMembers: group,
                });
            });
        });

        // Calculate total stS across all validators for weight calculation
        const totalStS = Array.from(validatorBalances.values()).reduce((sum, balance) => sum + balance, 0);

        console.log('\n📈 FINAL VALIDATOR ANALYSIS');
        console.log('============================');
        console.log(`🏆 Total stS across all validators: ${totalStS.toLocaleString()} stS`);
        console.log(`💎 Total S equivalent: ${(totalStS * stsRate).toLocaleString()} S`);
        console.log(`💱 Conversion rate: ${stsRate.toFixed(6)} S per stS\n`);

        const results: ValidatorBoostData[] = [];
        const csvData: string[] = ['validatorid,total_sts_amount,total_s_amount,weight'];

        // Sort validators by ID for consistent output
        const sortedValidators = Array.from(validatorBalances.entries()).sort(([a], [b]) => parseInt(a) - parseInt(b));

        for (const [validatorId, stsBalance] of sortedValidators) {
            const sBalance = stsBalance * stsRate;
            const weight = totalStS > 0 ? (stsBalance / totalStS) * 100 : 0;
            const sources = validatorSources.get(validatorId);

            console.log(`📊 Validator ${validatorId}:`);
            console.log(`   💰 Total stS Balance: ${stsBalance.toLocaleString()} stS`);
            console.log(`   💎 S Equivalent: ${sBalance.toLocaleString()} S`);
            console.log(`   ⚖️  Weight: ${weight.toFixed(4)}%`);

            if (sources?.isGrouped) {
                console.log(
                    `   👥 Grouped with: ${
                        sources.groupMembers?.filter((id) => id !== validatorId).join(', ') || 'none'
                    }`,
                );
            }
            console.log(`   🏠 Wallets: ${sources?.totalWallets || 0}`);

            // Show source breakdown
            console.log('   📋 Source Breakdown:');
            if (sources) {
                // Direct token balances
                const hasDirectTokens = Object.values(sources.directTokens).some((amount) => amount > 0);
                if (hasDirectTokens) {
                    Object.entries(sources.directTokens).forEach(([symbol, amount]) => {
                        if (amount > 0) {
                            const percentage = stsBalance > 0 ? (amount / stsBalance) * 100 : 0;
                            console.log(
                                `      💰 ${symbol}: ${amount.toLocaleString()} stS (${percentage.toFixed(2)}%)`,
                            );
                        }
                    });
                }

                // Pool balances
                if (sources.poolBalances > 0) {
                    const poolPercentage = stsBalance > 0 ? (sources.poolBalances / stsBalance) * 100 : 0;
                    console.log(
                        `      🏊 Pools: ${sources.poolBalances.toLocaleString()} stS (${poolPercentage.toFixed(2)}%)`,
                    );
                }

                // If no sources, show zero
                if (!hasDirectTokens && sources.poolBalances === 0) {
                    console.log(`      📭 No balance sources found`);
                }
            }
            console.log('');

            results.push({
                validatorId,
                totalStSBalance: stsBalance,
                totalSBalance: sBalance,
                weight,
            });

            csvData.push(`${validatorId},${stsBalance.toFixed(6)},${sBalance.toFixed(6)},${weight.toFixed(4)}`);
        }

        // Write CSV data to file (only in non-serverless environments)
        const csvContent = csvData.join('\n');
        const resultsDir = 'src/results';
        const fileName = `${resultsDir}/validator-delegation-boost.csv`;

        try {
            if (!fs.existsSync(resultsDir)) {
                fs.mkdirSync(resultsDir, { recursive: true });
            }

            fs.writeFileSync(fileName, csvContent, 'utf8');
            console.log(`✅ Results written to ${fileName} (${results.length} validators)`);
        } catch (error) {
            console.error('❌ Error writing CSV file:', error);
        }
    } catch (error) {
        core.setFailed(error as Error);
    }
}

run();
