import { describe, expect, it } from "vitest";
import { parseActions } from "../src/agents/llm/parse";

// A rejected action's error must say what is wrong. The exact wording is zod's, so tests only
// check that it names the field.
const mentions = (field: string) => expect.stringContaining(field);

describe("parseActions: reading the answer", () => {
    it('reads clean JSON', () => {
        expect(parseActions('{"actions":[{"type":"harvest","amount":300}]}'))
            .toEqual({ kind: "read", actions: [{ type: "harvest", amount: 300 }], rejected: [] });
    });

    it('reads JSON inside a ```json block', () => {
        const text = 'My move:\n```json\n{"actions":[{"type":"harvest","amount":300}]}\n```';
        expect(parseActions(text)).toEqual({ kind: "read", actions: [{ type: "harvest", amount: 300 }], rejected: [] });
    });

    it('reads JSON inside a block without a language tag', () => {
        const text = '```\n{"actions":[{"type":"harvest","amount":1}]}\n```';
        expect(parseActions(text)).toMatchObject({ kind: "read", actions: [{ type: "harvest", amount: 1 }] });
    });

    it('reads JSON with text before and after it', () => {
        const text = 'The pool looks low, so I will be careful.\n{"actions":[{"type":"harvest","amount":50}]}\nThat is all.';
        expect(parseActions(text)).toEqual({ kind: "read", actions: [{ type: "harvest", amount: 50 }], rejected: [] });
    });

    it.fails('reads JSON followed by prose that contains braces', () => {
        // Models write things like this. The JSON is fine; only the extraction must not overreach.
        const text = '{"actions":[{"type":"harvest","amount":1}]} I chose {fairness} over {greed}.';
        expect(parseActions(text)).toEqual({ kind: "read", actions: [{ type: "harvest", amount: 1 }], rejected: [] });
    });

    it('an empty action list is a valid "do nothing" turn, not an error', () => {
        expect(parseActions('{"actions":[]}')).toEqual({ kind: "read", actions: [], rejected: [] });
    });

    it('drops keys an action does not have', () => {
        const text = '{"actions":[{"type":"harvest","amount":5,"why":"fair"}]}';
        expect(parseActions(text)).toEqual({ kind: "read", actions: [{ type: "harvest", amount: 5 }], rejected: [] });
    });

    it('reads every kind of action', () => {
        const actions = [
            { type: "harvest", amount: 1 },
            { type: "gift", to: "b", amount: 2 },
            { type: "say", to: "all", text: "hello" },
            { type: "revise_values", text: "share more", reason: "the pool shrinks" },
        ];
        expect(parseActions(JSON.stringify({ actions }))).toEqual({ kind: "read", actions, rejected: [] });
    });
});

describe("parseActions: rejecting single actions", () => {
    it('rejects an unknown action type, by index', () => {
        expect(parseActions('{"actions":[{"type":"steal","amount":5}]}'))
            .toEqual({ kind: "read", actions: [], rejected: [{ index: 0, value: { type: "steal", amount: 5 }, error: mentions("type") }] });
    });

    it('rejects a negative amount', () => {
        expect(parseActions('{"actions":[{"type":"harvest","amount":-5}]}'))
            .toEqual({ kind: "read", actions: [], rejected: [{ index: 0, value: { type: "harvest", amount: -5 }, error: mentions("amount") }] });
    });

    it('rejects a fractional amount: credits are whole', () => {
        expect(parseActions('{"actions":[{"type":"harvest","amount":300.5}]}'))
            .toEqual({ kind: "read", actions: [], rejected: [{ index: 0, value: { type: "harvest", amount: 300.5 }, error: mentions("amount") }] });
    });

    it('reads an amount written as a string of digits', () => {
        expect(parseActions('{"actions":[{"type":"harvest","amount":"300"}]}'))
            .toEqual({ kind: "read", actions: [{ type: "harvest", amount: 300 }], rejected: [] });
    });

    it.each(['""', '"-5"', '"3.5"', '" 300"', '"1e3"', '"abc"', 'null', 'true', '[7]'])(
        'rejects the amount %s: only a plain string of digits is converted',
        (amount) => {
            expect(parseActions(`{"actions":[{"type":"harvest","amount":${amount}}]}`))
                .toEqual({ kind: "read", actions: [], rejected: [{ index: 0, value: { type: "harvest", amount: JSON.parse(amount) }, error: mentions("amount") }] });
        },
    );

    it('rejects an item that is not an object, and still reads the others', () => {
        const text = '{"actions":[null,{"type":"harvest","amount":1},5,"harvest"]}';
        expect(parseActions(text)).toEqual({
            kind: "read",
            actions: [{ type: "harvest", amount: 1 }],
            rejected: [
                { index: 0, value: null, error: expect.any(String) },
                { index: 2, value: 5, error: expect.any(String) },
                { index: 3, value: "harvest", error: expect.any(String) },
            ],
        });
    });

    it('leaves actions without an amount untouched', () => {
        const text = '{"actions":[{"type":"vote","proposalId":"p1","yes":true},{"type":"say","to":"all","text":"hi"}]}';
        expect(parseActions(text)).toEqual({
            kind: "read",
            actions: [{ type: "vote", proposalId: "p1", yes: true }, { type: "say", to: "all", text: "hi" }],
            rejected: [],
        });
    });

    it('keeps the valid actions next to an invalid one, and points at the invalid one', () => {
        const text = '{"actions":[{"type":"harvest","amount":300},{"type":"gift","to":"b","amount":-5},{"type":"vote","proposalId":"p1","yes":true}]}';
        expect(parseActions(text)).toEqual({
            kind: "read",
            actions: [{ type: "harvest", amount: 300 }, { type: "vote", proposalId: "p1", yes: true }],
            rejected: [{ index: 1, value: { type: "gift", to: "b", amount: -5 }, error: mentions("amount") }],
        });
    });
});

describe("parseActions: unreadable answers", () => {
    const unreadable = { kind: "unreadable", error: expect.any(String) };

    it('an empty answer', () => {
        expect(parseActions("")).toEqual(unreadable);
    });

    it('an answer with no JSON in it', () => {
        expect(parseActions("I will harvest 300 this turn.")).toEqual(unreadable);
    });

    it('invalid JSON: a trailing comma', () => {
        expect(parseActions('{"actions":[{"type":"harvest","amount":1},]}')).toEqual(unreadable);
    });

    it('invalid JSON: a missing closing brace', () => {
        expect(parseActions('{"actions":[{"type":"harvest","amount":1}]')).toEqual(unreadable);
    });

    it('an object without an `actions` key', () => {
        expect(parseActions('{"action":{"type":"harvest","amount":1}}')).toEqual(unreadable);
    });

    it('`actions` that is not a list', () => {
        expect(parseActions('{"actions":{"type":"harvest","amount":1}}')).toEqual(unreadable);
    });

    it('a bare array, the format we decided against', () => {
        expect(parseActions('[{"type":"harvest","amount":1}]')).toEqual(unreadable);
    });

    it('an answer longer than the cap', () => {
        const valid = '{"actions":[{"type":"harvest","amount":1}]}';
        expect(parseActions(valid + " ".repeat(100_000))).toEqual(unreadable);
    });
});
