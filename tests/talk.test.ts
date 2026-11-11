import { describe, expect, it } from "vitest";
import { routeMessages } from "../src/world/talk";
import type { AgentId, Say } from "../src/contracts";

const caps = { maxMessagesPerTick: 3, maxMessageChars: 20 };
const say = (to: AgentId | "all", text = "hi"): Say => ({ type: "say", to, text });
const sent = (entries: Record<AgentId, Say[]>) => new Map(Object.entries(entries));
const living = ["a", "b", "c"];

describe("routeMessages: delivery", () => {
    it("a private message reaches only its recipient, stamped with the tick it was said on", () => {
        const { inboxes } = routeMessages(4, sent({ a: [say("b", "psst")] }), living, caps);

        expect(inboxes).toEqual(new Map([["b", [{ from: "a", to: "b", tick: 4, text: "psst" }]]]));
    });

    it('a message to "all" reaches every living resident except the sender', () => {
        const { inboxes } = routeMessages(4, sent({ b: [say("all")] }), living, caps);

        expect([...inboxes.keys()].sort()).toEqual(["a", "c"]);
        expect(inboxes.get("a")).toEqual([{ from: "b", to: "all", tick: 4, text: "hi" }]);
    });

    it("an inbox keeps each sender's order, senders in id order, whatever order the turns came in", () => {
        const { inboxes } = routeMessages(4, sent({ c: [say("a", "c1")], b: [say("a", "b1"), say("a", "b2")] }), living, caps);

        expect(inboxes.get("a")?.map(m => m.text)).toEqual(["b1", "b2", "c1"]);
    });

    it("the last words of a sender who died this tick are still delivered", () => {
        const { inboxes } = routeMessages(4, sent({ gone: [say("a", "bye")] }), living, caps);

        expect(inboxes.get("a")?.map(m => m.text)).toEqual(["bye"]);
    });

    it("records one message event per message, not per recipient", () => {
        const { events } = routeMessages(4, sent({ a: [say("all", "x"), say("b", "y")] }), living, caps);

        expect(events).toEqual([
            { tick: 4, kind: "message", agent: "a", to: "all", text: "x" },
            { tick: 4, kind: "message", agent: "a", to: "b", text: "y" },
        ]);
    });

    it("nothing said, nothing delivered", () => {
        expect(routeMessages(4, new Map(), living, caps)).toEqual({ inboxes: new Map(), events: [] });
    });
});

describe("routeMessages: caps and drops", () => {
    it("keeps the first maxMessagesPerTick messages and drops the rest; \"all\" counts as one", () => {
        const { inboxes, events } = routeMessages(4,
            sent({ a: [say("all", "1"), say("b", "2"), say("c", "3"), say("b", "4"), say("all", "5")] }), living, caps);

        expect(inboxes.get("b")?.map(m => m.text)).toEqual(["1", "2"]);
        expect(inboxes.get("c")?.map(m => m.text)).toEqual(["1", "3"]);
        expect(events.filter(e => e.kind === "messageDropped")).toEqual([
            { tick: 4, kind: "messageDropped", agent: "a", to: "b", reason: "over the per-tick cap" },
            { tick: 4, kind: "messageDropped", agent: "a", to: "all", reason: "over the per-tick cap" },
        ]);
    });

    it("drops a message longer than maxMessageChars instead of cutting it; exactly the limit is fine", () => {
        const { inboxes, events } = routeMessages(4,
            sent({ a: [say("b", "x".repeat(21)), say("b", "y".repeat(20))] }), living, caps);

        expect(inboxes.get("b")?.map(m => m.text)).toEqual(["y".repeat(20)]);
        expect(events[0]).toEqual({ tick: 4, kind: "messageDropped", agent: "a", to: "b", reason: "too long" });
    });

    it("a dropped message does not use up the cap", () => {
        const { inboxes } = routeMessages(4,
            sent({ a: [say("b", "x".repeat(99)), say("b", "1"), say("b", "2"), say("b", "3")] }), living, caps);

        expect(inboxes.get("b")?.map(m => m.text)).toEqual(["1", "2", "3"]);
    });

    it("drops a message to someone who is not a living resident: unknown, or died this tick", () => {
        const { inboxes, events } = routeMessages(4, sent({ a: [say("ghost"), say("dead")] }), living, caps);

        expect(inboxes.size).toBe(0);
        expect(events.map(e => e.kind === "messageDropped" && e.reason)).toEqual(["no such living resident", "no such living resident"]);
    });

    it("drops a message to oneself", () => {
        const { inboxes, events } = routeMessages(4, sent({ a: [say("a")] }), living, caps);

        expect(inboxes.size).toBe(0);
        expect(events).toEqual([{ tick: 4, kind: "messageDropped", agent: "a", to: "a", reason: "to self" }]);
    });
});
