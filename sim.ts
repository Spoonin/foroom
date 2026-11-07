// Точка входа: pnpm sim. Сейчас только проверяет, что @cue/core подключён.
// Шаг 1: замените на цикл пустых тиков под Supervisor (`pnpm sim --ticks 3`).
import { Supervisor } from "@cue/core";

const system = new Supervisor({ onError: ({ childId, error }) => console.error(`[${childId}]`, error) });
console.log("foroom: @cue/core подключён, Supervisor создан");
system.stop();
