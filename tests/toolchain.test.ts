// Toolchain check, not logic: @cue/core resolves and works under vitest.
import { describe, expect, it } from "vitest";
import { Supervisor } from "@cue/core";

describe("toolchain", () => {
  it("@cue/core: a call to a Server returns a reply", async () => {
    const system = new Supervisor({ onError: () => {} });
    type Msg = { type: "ping"; reply: string };
    const server = system.spawnServer<{}, Msg>({
      initialState: {},
      handlers: { ping: (state) => ({ state, reply: "pong" }) },
    });
    expect(await server.call({ type: "ping" })).toBe("pong");
    system.stop();
  });
});
