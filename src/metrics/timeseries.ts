// timeseries.ts — see STEPS.md, step 2: `runs/<ts>.csv` with P(t).
//
// One row per tick, computed from the Ledger only, so the same seed always gives the same file.

import type { Tick } from "../contracts";
import { ofKind, type LedgerEvent } from "../world/ledger";

export interface TickRow {
    tick: Tick;
    P: number;
    collapsed: boolean;
    alive: number; // after this tick's deaths
    harvested: number; // gross, all agents together
    deaths: number;
    timeouts: number;
    policyFailures: number;
}

export function tickRows(events: readonly LedgerEvent[], population: number): TickRow[] {
    const count = (kind: LedgerEvent["kind"]) => {
        const byTick = new Map<Tick, number>();
        for (const e of events) if (e.kind === kind) byTick.set(e.tick, (byTick.get(e.tick) ?? 0) + 1);
        return byTick;
    };
    const deaths = count("death");
    const timeouts = count("timeout");
    const failures = count("policyFailed");
    const harvested = new Map<Tick, number>();
    for (const e of ofKind(events, "harvest")) harvested.set(e.tick, (harvested.get(e.tick) ?? 0) + e.gross);

    let alive = population;
    return ofKind(events, "pool").map(({ tick, P, collapsed }) => {
        alive -= deaths.get(tick) ?? 0;
        return {
            tick, P, collapsed, alive,
            harvested: harvested.get(tick) ?? 0,
            deaths: deaths.get(tick) ?? 0,
            timeouts: timeouts.get(tick) ?? 0,
            policyFailures: failures.get(tick) ?? 0,
        };
    });
}

const COLUMNS: readonly (keyof TickRow)[] = ["tick", "P", "collapsed", "alive", "harvested", "deaths", "timeouts", "policyFailures"];

// Every value is a number or a boolean, so nothing needs quoting.
export function toCsv(rows: readonly TickRow[]): string {
    const lines = rows.map(row => COLUMNS.map(c => String(row[c])).join(","));
    return [COLUMNS.join(","), ...lines].join("\n") + "\n";
}
