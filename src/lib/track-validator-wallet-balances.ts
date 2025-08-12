import 'dotenv/config';
import { createPublicClient, http, formatUnits, getAddress, parseEther, formatEther } from 'viem';
import { sonic } from 'viem/chains';
import * as fs from 'fs';
import { API_URL, trackedTokens, stSAddress } from './constants';
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

export async function trackWalletBalances() {
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

        const tokenInfoMap = new Map(allTokens.map((token, index) => [token, tokenInfos[index]]));

        // Array to store validator balances
        const validatorBalances = new Map<string, number>();

        // Get stS conversion rate
        const stsRate = await getStSRate();

        // First pass: collect all balances per validator
        for (const [validatorId, wallets] of Object.entries(validatorMapping)) {
            let validatorTotalStS = 0;

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
                        totalCombinedBalance += parseFloat(formattedBalance);
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
                } catch (error) {
                    console.error(`    ❌ Error fetching pool data for ${wallet}:`, error);
                }

                validatorTotalStS += totalCombinedBalance;
            }

            validatorBalances.set(validatorId, validatorTotalStS);
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

        // Distribute group balances evenly among group members
        VALIDATOR_GROUPS.forEach((group, groupId) => {
            const groupBalance = groupBalances.get(groupId) || 0;
            const avgBalance = groupBalance / group.length;

            group.forEach((validatorId) => {
                validatorBalances.set(validatorId, avgBalance);
            });
        });
        console.log();

        // Calculate total stS across all validators for weight calculation
        const totalStS = Array.from(validatorBalances.values()).reduce((sum, balance) => sum + balance, 0);

        const results: ValidatorBoostData[] = [];
        const csvData: string[] = ['validatorid,total_sts_amount,total_s_amount,weight'];

        // Sort validators by ID for consistent output
        const sortedValidators = Array.from(validatorBalances.entries()).sort(([a], [b]) => parseInt(a) - parseInt(b));

        for (const [validatorId, stsBalance] of sortedValidators) {
            const sBalance = stsBalance * stsRate;
            const weight = totalStS > 0 ? (stsBalance / totalStS) * 100 : 0;

            // Check if validator is in a group
            let isGrouped = false;
            let groupId: number | undefined;

            VALIDATOR_GROUPS.forEach((group, index) => {
                if (group.includes(validatorId)) {
                    isGrouped = true;
                    groupId = index;
                }
            });

            results.push({
                validatorId,
                totalStSBalance: stsBalance,
                totalSBalance: sBalance,
                weight,
                isGrouped,
                groupId,
            });

            csvData.push(`${validatorId},${stsBalance.toFixed(6)},${sBalance.toFixed(6)},${weight.toFixed(4)}`);
        }

        // Write CSV data to file (only in non-serverless environments)
        const csvContent = csvData.join('\n');
        const resultsDir = 'src/results';
        const fileName = `${resultsDir}/validator-delegation-boost.csv`;

        // Check if we're in a serverless environment
        const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.FUNCTIONS_WORKER;

        if (!isServerless) {
            try {
                if (!fs.existsSync(resultsDir)) {
                    fs.mkdirSync(resultsDir, { recursive: true });
                }

                fs.writeFileSync(fileName, csvContent, 'utf8');
                console.log(`📄 Results written to ${fileName}`);
            } catch (error) {
                console.error('Error writing CSV file:', error);
            }
        } else {
            console.log('📄 Serverless environment detected - CSV data included in response instead of file');
        }

        // Return the results for API usage
        return {
            summary: {
                totalStS: totalStS,
                stsRate: stsRate,
                validatorCount: results.length,
                csvFileName: fileName,
            },
            validators: results,
            csvData: csvContent,
        };
    } catch (error) {
        console.error('Error tracking wallet balances:', error);
        throw error;
    }
}
