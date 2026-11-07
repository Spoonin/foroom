// Проверка инструментов, а не логики: @cue/core резолвится и работает под vitest.
import { describe, expect, it } from "vitest";
import { Supervisor } from "@cue/core";

describe("toolchain", () => {
  it("@cue/core: call к Server возвращает ответ", async () => {
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
