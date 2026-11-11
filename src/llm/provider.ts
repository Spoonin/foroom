export interface LLMMessage{
    role: "user" | "assistant";
    content: string;
}

export interface LLMRequest {
    system: string;
    messages: LLMMessage[];
    maxTokens: number;
    temperature?: number;
    schema?: Record<string, unknown>;
}

export interface LLMResponse{
    text: string;
    usage: { inputTokens: number; outputTokens: number };
    stopReason: "end" | "maxTokens" | "other";
    model: string;
}

export interface LLMProvider{
    complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
}

// A canned answer: plain text, or text with how it ended (to test an answer cut off at maxTokens).
export type MockAnswer = string | { text: string; stopReason: LLMResponse["stopReason"] };

export class MockProvider implements LLMProvider{
    constructor(
        private readonly answers: MockAnswer[] | ((req: LLMRequest) => MockAnswer), 
        private readonly options?:{delayMs:number}
    ){}
    private curAnswerIndex = 0;
    public requests: LLMRequest[] = [];

    async complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>{
        signal?.throwIfAborted()
        this.requests.push(request);

        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, this.options?.delayMs ?? 0); });
        const aborted = new Promise<void>(resolve => {
            onAbort = resolve;
            signal?.addEventListener("abort", onAbort, { once: true });
        });
        try {
            await Promise.race([deadline, aborted]);
            signal?.throwIfAborted();
        } finally {
            clearTimeout(timer);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
        }

        let curAnswer: MockAnswer;
        if(Array.isArray(this.answers)){
            const answer = this.answers[this.curAnswerIndex];
            if(answer === undefined){
                throw new Error("answers ran out");
            }
            curAnswer = answer;
            this.curAnswerIndex++;
        } else {
            curAnswer = this.answers(request);
        }

        const { text, stopReason } = typeof curAnswer === "string" ? { text: curAnswer, stopReason: "end" as const } : curAnswer;

        return {
            model: "Mock model",
            stopReason,
            text,
            usage: {
                inputTokens: Math.floor((request.messages.reduce((t, i) => t += i.content.length, 0) + request.system.length)/3),
                outputTokens: Math.floor(text.length/3),
            }
        }
    }
}
