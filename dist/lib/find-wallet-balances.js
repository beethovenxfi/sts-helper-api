"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const viem_1 = require("viem");
const chains_1 = require("viem/chains");
const fs = __importStar(require("fs"));
const constants_1 = require("./constants");
const TRACKED_TOKENS = [
    '0xeaa74d7f42267eb907092af4bc700f667eed0b8b', // asonstS
    '0x396922EF30Cf012973343f7174db850c7D265278', // bstS-3
];
const STS_ADDRESS = constants_1.stSAddress;
// Define validator groups that share wallet balances
const VALIDATOR_GROUPS = [
    ['15', '16', '17', '18'], // Group 1: validators 15, 16, 17, 18
    ['13', '14'], // Group 2: validators 13, 14
];
const client = (0, viem_1.createPublicClient)({
    chain: chains_1.sonic,
    transport: (0, viem_1.http)(),
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
async function getTokenInfo(tokenAddress) {
    try {
        const [symbol, decimals] = await Promise.all([
            client.readContract({
                address: (0, viem_1.getAddress)(tokenAddress),
                abi: ERC20_ABI,
                functionName: 'symbol',
            }),
            client.readContract({
                address: (0, viem_1.getAddress)(tokenAddress),
                abi: ERC20_ABI,
                functionName: 'decimals',
            }),
        ]);
        return { symbol, decimals };
    }
    catch (error) {
        console.error(`Error getting token info for ${tokenAddress}:`, error);
        return { symbol: 'UNKNOWN', decimals: 18 };
    }
}
async function getTokenBalance(tokenAddress, walletAddress) {
    try {
        const balance = await client.readContract({
            address: (0, viem_1.getAddress)(tokenAddress),
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [(0, viem_1.getAddress)(walletAddress)],
        });
        return balance;
    }
    catch (error) {
        console.error(`Error getting balance for token ${tokenAddress} and wallet ${walletAddress}:`, error);
        return 0n;
    }
}
async function getStSRate() {
    try {
        const rate = await client.readContract({
            address: (0, viem_1.getAddress)(STS_ADDRESS),
            abi: STS_ABI,
            functionName: 'getRate',
        });
        // Rate is returned as a uint256, convert to decimal (assuming 18 decimals)
        return parseFloat((0, viem_1.formatUnits)(rate, 18));
    }
    catch (error) {
        console.error('Error getting stS rate:', error);
        return 1; // Default to 1:1 rate if there's an error
    }
}
async function getPoolDataForUser(userAddress) {
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
        const response = await fetch(constants_1.API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query }),
        });
        const data = (await response.json());
        if (!data?.data?.poolGetPools) {
            return [];
        }
        return data.data.poolGetPools;
    }
    catch (error) {
        console.error(`Error fetching pool data for ${userAddress}:`, error);
        return [];
    }
}
async function run() {
    try {
        const validatorMappingEnv = process.env.VALIDATOR_MAPPING;
        if (!validatorMappingEnv) {
            throw new Error('VALIDATOR_MAPPING environment variable is required');
        }
        // Parse from environment variable (JSON string)
        const validatorMapping = JSON.parse(validatorMappingEnv);
        const allTokens = [...TRACKED_TOKENS, STS_ADDRESS];
        const tokenInfoPromises = allTokens.map((token) => getTokenInfo(token));
        const tokenInfos = await Promise.all(tokenInfoPromises);
        const tokenInfoMap = new Map(allTokens.map((token, index) => [token, tokenInfos[index]]));
        // Array to store validator balances
        const validatorBalances = new Map();
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
                    const token = allTokens[i];
                    const balance = balances[i];
                    const tokenInfo = tokenInfoMap.get(token);
                    if (tokenInfo) {
                        const formattedBalance = (0, viem_1.formatUnits)(balance, tokenInfo.decimals);
                        totalCombinedBalance += parseFloat(formattedBalance);
                    }
                }
                // Get pool balances for stS token
                try {
                    const poolData = await getPoolDataForUser(wallet);
                    let totalStSInPools = 0;
                    for (const pool of poolData) {
                        const stsToken = pool.poolTokens.find((token) => token.address.toLowerCase() === STS_ADDRESS.toLowerCase());
                        if (stsToken && pool.dynamicData.totalShares && pool.userBalance.totalBalance) {
                            const userShare = parseFloat(pool.userBalance.totalBalance) / parseFloat(pool.dynamicData.totalShares);
                            const userStSAmount = parseFloat(stsToken.balance) * userShare;
                            totalStSInPools += userStSAmount;
                        }
                    }
                    totalCombinedBalance += totalStSInPools;
                }
                catch (error) {
                    console.error(`    ❌ Error fetching pool data for ${wallet}:`, error);
                }
                validatorTotalStS += totalCombinedBalance;
            }
            validatorBalances.set(validatorId, validatorTotalStS);
        }
        const groupBalances = new Map();
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
        const results = [];
        const csvData = ['validatorid,total_sts_amount,total_s_amount,weight'];
        // Sort validators by ID for consistent output
        const sortedValidators = Array.from(validatorBalances.entries()).sort(([a], [b]) => parseInt(a) - parseInt(b));
        for (const [validatorId, stsBalance] of sortedValidators) {
            const sBalance = stsBalance * stsRate;
            const weight = totalStS > 0 ? (stsBalance / totalStS) * 100 : 0;
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
            console.log(`📄 Results written to ${fileName}`);
        }
        catch (error) {
            console.error('Error writing CSV file:', error);
        }
    }
    catch (error) {
        core.setFailed(error);
    }
}
run();
