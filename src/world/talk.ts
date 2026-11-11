// talk.ts — see STEPS.md, step 4 (talk).
//
// Routing `say` messages, as a pure function. Runner calls it after a tick is resolved: what was
// said on tick t reaches the recipients' inboxes before tick t+1 starts, never during tick t.
// Talk is free in credits; it is bounded by volume instead (laws.maxMessagesPerTick and
// laws.maxMessageChars). Anything over a cap, or to nobody, is dropped and logged, never cut.

import type { AgentId, Laws, Message, Say, Tick } from "../contracts";
import type { LedgerEvent } from "./ledger";

export type DropReason = "over the per-tick cap" | "too long" | "no such living resident" | "to self";

export interface Routing {
    inboxes: Map<AgentId, Message[]>; // per living recipient, in send order; only recipients with mail
    events: LedgerEvent[]; // one `message` per delivered message, one `messageDropped` per dropped one
}

const compareIds = (a: AgentId, b: AgentId): number => (a < b ? -1 : a > b ? 1 : 0);

// `sent`: each sender's messages for `tick`, in the order it said them.
// `living`: who can receive (the survivors of the tick). A sender who died this tick still has its
// last words delivered; a recipient who died gets nothing.
export function routeMessages(
    tick: Tick,
    sent: ReadonlyMap<AgentId, readonly Say[]>,
    living: readonly AgentId[],
    laws: Pick<Laws, "maxMessagesPerTick" | "maxMessageChars">,
): Routing {
    const inboxes = new Map<AgentId, Message[]>();
    const events: LedgerEvent[] = [];
    const alive = new Set(living);
    const deliver = (to: AgentId, message: Message) => {
        if (!inboxes.has(to)) inboxes.set(to, []);
        inboxes.get(to)!.push(message);
    };

    // Senders in id order, so inboxes and events never depend on who submitted first.
    for (const from of [...sent.keys()].sort(compareIds)) {
        let accepted = 0;
        for (const { to, text } of sent.get(from)!) {
            const drop = (reason: DropReason) => events.push({ tick, kind: "messageDropped", agent: from, to, reason });
            if (accepted >= laws.maxMessagesPerTick) { drop("over the per-tick cap"); continue; }
            if (text.length > laws.maxMessageChars) { drop("too long"); continue; }
            if (to === from) { drop("to self"); continue; }
            if (to !== "all" && !alive.has(to)) { drop("no such living resident"); continue; }

            accepted++;
            const message: Message = { from, to, tick, text };
            events.push({ tick, kind: "message", agent: from, to, text });
            if (to === "all") {
                for (const id of [...alive].sort(compareIds)) if (id !== from) deliver(id, message);
            } else {
                deliver(to, message);
            }
        }
    }
    return { inboxes, events };
}
