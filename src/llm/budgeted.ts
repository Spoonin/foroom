// budgeted.ts — see STEPS.md, step 3.
//
// A Provider that wraps another and stops the run when the run's token budget is spent. It is a
// guard, not a logger: the transcript and the summary count tokens; this only decides when to stop.
//
// How it stops: when an answer takes the total over the budget, `onExhausted` fires once. sim.ts
// aborts the run's AbortController there, so the run ends the way Ctrl+C ends it. Every call after
// that is refused at once, without reaching the model.
//
// Tokens, not money: input + output, cached input included. Simple and conservative; a budget in
// dollars needs per-model prices, which change.
//
// Overshoot: calls already in flight when the budget runs out still finish and are paid for. With
// N agents thinking at once, a run can end up to about N × (prompt + maxTokens) over the budget.
// Accepted: the hard spending limit on the provider account is the real safety net.

import type { LLMRequest, LLMResponse, Provider } from "./provider";

export interface BudgetOptions {
    maxTokens: number;
    onExhausted: (spent: number) => void; // called once, by the answer that crossed the budget
}

const tokens = new Intl.NumberFormat("en-US").format;

export class BudgetedProvider implements Provider {
    private total = 0;
    private exhausted = false;

    constructor(private readonly inner: Provider, private readonly options: BudgetOptions) {}

    get spent(): number {
        return this.total;
    }

    async complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (this.exhausted) {
            throw new Error(`token budget exhausted: ${tokens(this.total)} of ${tokens(this.options.maxTokens)} tokens spent`);
        }
        // A failed or aborted call throws here and is not counted: nothing came back to count.
        const response = await this.inner.complete(request, signal);

        this.total += response.usage.inputTokens + response.usage.outputTokens;
        if (!this.exhausted && this.total >= this.options.maxTokens) {
            this.exhausted = true;
            this.options.onExhausted(this.total);
        }
        return response; // already paid for, so it is used even when it crossed the budget
    }
}
