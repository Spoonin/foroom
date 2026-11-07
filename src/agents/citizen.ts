// citizen.ts — see STEPS.md, step 2 (pipe-to-self — step 3).
//
// The agent actor: on tick — the policy decides; local actions (say, revise_values) are handled here,
// world actions go in exactly one submit to replyTo. Talk: hear handler + one send function
// (Ledger first, then cast to peers; hear before submit). No await in handlers.

export {};
