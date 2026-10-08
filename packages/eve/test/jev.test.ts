import { afterEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
vi.mock("eve/ai", () => ({ decide }));

const { jevEvaluator, typesafeModel } = await import("../src/jev.js");

afterEach(() => {
	vi.unstubAllEnvs();
	decide.mockReset();
});

describe("typesafeModel", () => {
	it("is undefined without a key, so decide uses AI Gateway", () => {
		vi.stubEnv("TYPESAFE_API_KEY", undefined);
		vi.stubEnv("TYPESAFE_AI_API_KEY", undefined);
		expect(typesafeModel()).toBeUndefined();
	});

	it("returns a Jev model when either key is set", () => {
		vi.stubEnv("TYPESAFE_API_KEY", undefined);
		vi.stubEnv("TYPESAFE_AI_API_KEY", "test-key");
		expect(typesafeModel()).toMatchObject({ modelId: "jev-latest" });
	});
});

describe("jevEvaluator", () => {
	it("forwards state, questions, and the bound model to decide", async () => {
		decide.mockResolvedValue({ answers: { q: { probability: 0.7 } } });
		const signal = new AbortController().signal;
		const run = jevEvaluator<{ type: "boolean" }, { probability: number }>("typesafe-ai/jev");
		const result = await run({ state: { a: 1 }, questions: { q: { type: "boolean" } }, abortSignal: signal });
		expect(result.answers.q?.probability).toBe(0.7);
		expect(decide).toHaveBeenCalledWith({
			state: { a: 1 },
			questions: { q: { type: "boolean" } },
			abortSignal: signal,
			model: "typesafe-ai/jev",
		});
	});
});
