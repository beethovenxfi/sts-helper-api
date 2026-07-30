import { ALLOWED_VALIDATORS, BEETS_VALIDATOR_ID } from './constants';
import { getDelegationState } from './helper';
import { formatEther, parseEther } from 'viem/utils';

interface WithdrawalRecommendation {
    withdrawalAmount: string;
    validatorId: string;
}

interface ValidatorAnalysis {
    validatorId: string;
    currentDelegation: bigint;
    expectedDelegation: bigint;
    overDelegated: bigint;
    isOverDelegated: boolean;
}

// Withdraw up to `available(validator)` from each validator (highest available first)
// until the remaining amount is covered. Returns the amount still uncovered.
function withdrawFrom(
    validators: ValidatorAnalysis[],
    available: (v: ValidatorAnalysis) => bigint,
    remainingWithdrawal: bigint,
    recommendations: WithdrawalRecommendation[],
): bigint {
    const sorted = [...validators].sort((a, b) => (available(b) > available(a) ? 1 : -1));

    for (const validator of sorted) {
        if (remainingWithdrawal <= 0n) break;

        const availableWithdrawal = remainingWithdrawal > available(validator) ? available(validator) : remainingWithdrawal;

        if (availableWithdrawal > 0n) {
            recommendations.push({
                withdrawalAmount: availableWithdrawal.toString(),
                validatorId: validator.validatorId,
            });

            remainingWithdrawal -= availableWithdrawal;
        }
    }

    return remainingWithdrawal;
}

function calculateWithdrawalsWithPriority(
    notAllowedValidators: ValidatorAnalysis[],
    allowedValidators: ValidatorAnalysis[],
    withdrawalAmount: bigint,
): WithdrawalRecommendation[] {
    const recommendations: WithdrawalRecommendation[] = [];
    let remaining = withdrawalAmount;

    // PRIORITY 1: Withdraw from not-allowed validators first (withdraw to 0)
    remaining = withdrawFrom(notAllowedValidators, (v) => v.currentDelegation, remaining, recommendations);

    // PRIORITY 2: Withdraw the over-delegated portion from allowed validators
    remaining = withdrawFrom(
        allowedValidators.filter((v) => v.isOverDelegated),
        (v) => v.overDelegated,
        remaining,
        recommendations,
    );

    // PRIORITY 3: Withdraw from allowed validators with the biggest delegation first
    remaining = withdrawFrom(allowedValidators, (v) => v.currentDelegation, remaining, recommendations);

    if (remaining > 0n) {
        throw new Error(
            `Unable to withdraw the full amount of ${formatEther(withdrawalAmount)} S. Remaining: ${formatEther(
                remaining,
            )} S`,
        );
    }

    // double check that all recommendations add up to the requested withdrawal amount
    const totalWithdrawal = recommendations.reduce((sum, rec) => sum + BigInt(rec.withdrawalAmount), 0n);
    if (totalWithdrawal !== withdrawalAmount) {
        throw new Error(
            `Total withdrawal amount ${formatEther(totalWithdrawal)} S does not match requested amount ${formatEther(
                withdrawalAmount,
            )} S`,
        );
    }

    return recommendations;
}

export async function calculateOptimalWithdrawals(withdrawalAmount: bigint): Promise<WithdrawalRecommendation[]> {
    const { delegations, allValidatorIds, expectedDelegations } = await getDelegationState();

    // Analyze each validator - including not-allowed ones for withdrawal
    const allowedValidators: ValidatorAnalysis[] = [];
    const notAllowedValidators: ValidatorAnalysis[] = [];

    for (const validatorId of allValidatorIds) {
        const currentDelegation = parseEther(delegations.get(validatorId) || '0');

        // our own validator is excluded from withdrawals
        if (validatorId === BEETS_VALIDATOR_ID) continue;

        if (!ALLOWED_VALIDATORS.includes(validatorId)) {
            // Not-allowed validators should be withdrawn to 0
            if (currentDelegation > 0n) {
                notAllowedValidators.push({
                    validatorId,
                    currentDelegation,
                    expectedDelegation: 0n,
                    overDelegated: currentDelegation, // All delegation is over-delegation
                    isOverDelegated: true,
                });
            }
            continue;
        }

        const expectedDelegation = parseEther((expectedDelegations.get(validatorId) || 0).toString());
        const difference = currentDelegation - expectedDelegation;
        const isOverDelegated = difference > parseEther('1'); // Consider over-delegated if difference > 1 S

        allowedValidators.push({
            validatorId,
            currentDelegation,
            expectedDelegation,
            overDelegated: isOverDelegated ? difference : 0n,
            isOverDelegated,
        });
    }

    // Calculate withdrawal recommendations - prioritize not-allowed validators first
    return calculateWithdrawalsWithPriority(notAllowedValidators, allowedValidators, withdrawalAmount);
}
