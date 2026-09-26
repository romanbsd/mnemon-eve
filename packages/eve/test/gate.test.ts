import { describe, expect, it } from "vitest";

import { jevGate, llmGate, type MemoryGateInput, MnemonEveGateError } from "../src/index.js";

const input: MemoryGateInput = {
	fact: "Invoices are approved by the finance lead",
	audience: "organization",
	audienceDescription: "Shared with everyone in the organization.",
	recentContext: "who approves invoices?",
	relatedMemories: [],
};

const flags = {
	durable: true,
	transient: false,
	duplicate: false,
	appropriateAudience: true,
	sensitive: false,
};

function fakeFetch(content: string | null, status = 200) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

describe("llmGate", () => {
	it("sends a structured-output request with configurable url, key, and model", async () => {
		const { fn, calls } = fakeFetch(JSON.stringify(flags));
		const gate = llmGate({ apiKey: "k", baseURL: "http://llm.local/v1/", model: "m", fetch: fn });
		expect(await gate(input)).toEqual({ accept: true, reasons: [] });
		const [call] = calls;
		expect(call?.url).toBe("http://llm.local/v1/chat/completions");
		expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer k");
		const body = JSON.parse(call?.init.body as string);
		expect(body.model).toBe("m");
		expect(body.response_format.json_schema.schema.required).toEqual([
			...Object.keys(flags),
			"category",
			"importance",
			"supersedes",
		]);
		expect(JSON.parse(body.messages[1].content).candidate.fact).toBe(input.fact);
	});

	it("defaults to gpt-5-mini and omits auth without a key", async () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const { fn, calls } = fakeFetch(JSON.stringify(flags));
			await llmGate({ fetch: fn })(input);
			expect(JSON.parse(calls[0]?.init.body as string).model).toBe("gpt-5-mini");
			expect(calls[0]?.url).toMatch(/\/chat\/completions$/);
			expect(calls[0]?.init.headers).not.toHaveProperty("authorization");
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
		}
	});

	it("classifies accepted facts and omits invalid classifications", async () => {
		const ok = fakeFetch(JSON.stringify({ ...flags, category: "decision", importance: 4 }));
		expect(await llmGate({ fetch: ok.fn })(input)).toEqual({
			accept: true,
			reasons: [],
			category: "decision",
			importance: 4,
		});
		const bad = fakeFetch(JSON.stringify({ ...flags, category: "nope", importance: 9 }));
		expect(await llmGate({ fetch: bad.fn })(input)).toEqual({ accept: true, reasons: [] });
	});

	it("maps superseded indexes to related ids and ignores out-of-range ones", async () => {
		const related = {
			...input,
			relatedMemories: [
				{ id: "a", content: "Invoices are approved by the CFO" },
				{ id: "b", content: "Invoices are paid monthly" },
			],
		};
		const ok = fakeFetch(JSON.stringify({ ...flags, supersedes: [0, 7] }));
		expect(await llmGate({ fetch: ok.fn })(related)).toMatchObject({ supersedes: ["a"] });
		const none = fakeFetch(JSON.stringify({ ...flags, supersedes: [] }));
		expect(await llmGate({ fetch: none.fn })(related)).not.toHaveProperty("supersedes");
		const rejected = fakeFetch(JSON.stringify({ ...flags, durable: false, supersedes: [0] }));
		expect(await llmGate({ fetch: rejected.fn })(related)).not.toHaveProperty("supersedes");
	});

	it("rejects on failed checks and fails closed on bad output", async () => {
		const reject = fakeFetch(JSON.stringify({ ...flags, transient: true, sensitive: true }));
		expect(await llmGate({ fetch: reject.fn })(input)).toEqual({
			accept: false,
			reasons: ["transient", "sensitive"],
		});
		for (const content of ["not json", JSON.stringify({ durable: true }), null]) {
			expect(await llmGate({ fetch: fakeFetch(content).fn })(input)).toEqual({
				accept: false,
				reasons: ["invalid-evaluation"],
			});
		}
		await expect(llmGate({ fetch: fakeFetch(null, 401).fn })(input)).rejects.toThrow(
			MnemonEveGateError,
		);
	});
});

describe("jevGate", () => {
	it("applies the threshold and fails closed on missing answers", async () => {
		const p = (v: number) => ({ probability: v });
		const answers = {
			durable: p(0.7),
			transient: p(0.2),
			duplicate: p(0.1),
			appropriateAudience: p(0.6),
			sensitive: p(0.05),
		};
		expect(await jevGate({ evaluate: async () => ({ answers }) })(input)).toEqual({
			accept: true,
			reasons: [],
		});
		expect(
			await jevGate({ threshold: 0.8, evaluate: async () => ({ answers }) })(input),
		).toEqual({ accept: false, reasons: ["durable", "appropriateAudience"] });
		const { sensitive: _, ...partial } = answers;
		expect(
			await jevGate({ evaluate: async () => ({ answers: partial }) })(input),
		).toEqual({ accept: false, reasons: ["invalid-evaluation"] });
	});

	it("classifies accepted facts from the same evaluation", async () => {
		const p = (v: number) => ({ probability: v });
		const answers = {
			durable: p(0.9),
			transient: p(0.1),
			duplicate: p(0.1),
			appropriateAudience: p(0.9),
			sensitive: p(0.01),
			category: { choice: "fact" },
			importance: { score: 2.6 },
		};
		let asked: string[] = [];
		const gate = jevGate({
			evaluate: async ({ questions }) => {
				asked = Object.keys(questions);
				return { answers };
			},
		});
		expect(await gate(input)).toEqual({
			accept: true,
			reasons: [],
			category: "fact",
			importance: 4,
		});
		expect(asked).toContain("category");
		expect(asked).toContain("importance");
		const rejected = jevGate({
			evaluate: async () => ({ answers: { ...answers, durable: p(0.1) } }),
		});
		expect(await rejected(input)).toEqual({ accept: false, reasons: ["durable"] });
	});

	it("asks one supersede question per related memory and applies the stricter threshold", async () => {
		const p = (v: number) => ({ probability: v });
		const related = {
			...input,
			relatedMemories: [
				{ id: "a", content: "Invoices are approved by the CFO" },
				{ id: "b", content: "Invoices are approved within two days" },
				{ id: "c", content: "Invoices are paid monthly" },
			],
		};
		let asked: string[] = [];
		const answers = {
			durable: p(0.9),
			transient: p(0.1),
			duplicate: p(0.1),
			appropriateAudience: p(0.9),
			sensitive: p(0.01),
			supersedes_0: p(0.95),
			supersedes_1: p(0.7),
			supersedes_2: p(0.05),
		};
		const gate = jevGate({
			evaluate: async ({ questions }) => {
				asked = Object.keys(questions);
				return { answers };
			},
		});
		expect(await gate(related)).toEqual({ accept: true, reasons: [], supersedes: ["a"] });
		expect(asked.filter((k) => k.startsWith("supersedes_"))).toHaveLength(3);
		expect(
			await jevGate({ supersedeThreshold: 0.6, evaluate: async () => ({ answers }) })(related),
		).toMatchObject({ supersedes: ["a", "b"] });
		expect(
			await jevGate({
				evaluate: async () => ({ answers: { ...answers, durable: p(0.1) } }),
			})(related),
		).toEqual({ accept: false, reasons: ["durable"] });
	});
});
