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
// until the remaining amount is covered. `consumed` tracks what earlier priorities already
// took from a validator, so the same funds are never withdrawn twice. Returns the amount
// still uncovered.
function withdrawFrom(
    validators: ValidatorAnalysis[],
    available: (v: ValidatorAnalysis) => bigint,
    remainingWithdrawal: bigint,
    consumed: Map<string, bigint>,
): bigint {
    const capacity = (v: ValidatorAnalysis) => {
        const left = available(v) - (consumed.get(v.validatorId) || 0n);
        return left > 0n ? left : 0n;
    };

    const sorted = [...validators].sort((a, b) => (capacity(b) > capacity(a) ? 1 : -1));

    for (const validator of sorted) {
        if (remainingWithdrawal <= 0n) break;

        const validatorCapacity = capacity(validator);
        const availableWithdrawal = remainingWithdrawal > validatorCapacity ? validatorCapacity : remainingWithdrawal;

        if (availableWithdrawal > 0n) {
            consumed.set(validator.validatorId, (consumed.get(validator.validatorId) || 0n) + availableWithdrawal);

            remainingWithdrawal -= availableWithdrawal;
        }
    }

    return remainingWithdrawal;
}

function calculateWithdrawalsWithPriority(
    notAllowedValidators: ValidatorAnalysis[],
    allowedValidators: ValidatorAnalysis[],
    beetsValidator: ValidatorAnalysis | undefined,
    withdrawalAmount: bigint,
): WithdrawalRecommendation[] {
    // Amount already assigned per validator, in priority order
    const consumed = new Map<string, bigint>();
    let remaining = withdrawalAmount;

    // PRIORITY 1: Withdraw from not-allowed validators first (withdraw to 0)
    remaining = withdrawFrom(notAllowedValidators, (v) => v.currentDelegation, remaining, consumed);

    // PRIORITY 2: Withdraw the over-delegated portion from allowed validators
    remaining = withdrawFrom(
        allowedValidators.filter((v) => v.isOverDelegated),
        (v) => v.overDelegated,
        remaining,
        consumed,
    );

    // PRIORITY 3: Withdraw from allowed validators with the biggest delegation first
    remaining = withdrawFrom(allowedValidators, (v) => v.currentDelegation, remaining, consumed);

    // PRIORITY 4: Our own validator as a last resort, once every other source is drained
    if (beetsValidator) {
        remaining = withdrawFrom([beetsValidator], (v) => v.currentDelegation, remaining, consumed);
    }

    if (remaining > 0n) {
        throw new Error(
            `Unable to withdraw the full amount of ${formatEther(withdrawalAmount)} S. Remaining: ${formatEther(
                remaining,
            )} S`,
        );
    }

    // One entry per validator, in the order the priorities consumed them
    const recommendations: WithdrawalRecommendation[] = [...consumed.entries()]
        .filter(([, amount]) => amount > 0n)
        .map(([validatorId, amount]) => ({ withdrawalAmount: amount.toString(), validatorId }));

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
    let beetsValidator: ValidatorAnalysis | undefined;

    for (const validatorId of allValidatorIds) {
        const currentDelegation = parseEther(delegations.get(validatorId) || '0');

        // our own validator is only withdrawn from as a last resort
        if (validatorId === BEETS_VALIDATOR_ID) {
            if (currentDelegation > 0n) {
                beetsValidator = {
                    validatorId,
                    currentDelegation,
                    expectedDelegation: currentDelegation,
                    overDelegated: 0n,
                    isOverDelegated: false,
                };
            }
            continue;
        }

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
    return calculateWithdrawalsWithPriority(notAllowedValidators, allowedValidators, beetsValidator, withdrawalAmount);
}
