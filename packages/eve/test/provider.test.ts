import type { MnemonClient } from "@romanbsd/mnemon-core";
import { describe, expect, it, vi } from "vitest";

import { postgresAvailable, withMnemon } from "../../core/test/integration/helpers.js";
import {
	type MemoryAudience,
	type MemoryEvaluator,
	type MnemonEveEvent,
	mnemonMemory,
	jevGate,
	type ProposalResult,
	type RecallFilter,
} from "../src/index.js";

const available = await postgresAvailable();

/** Deterministic stand-in for Jev driven by markers in the candidate. */
const fakeEvaluate: MemoryEvaluator = async ({ state }) => {
	const fact = (state.candidate as { fact: string }).fact;
	const related = state.relatedMemories as { content: string }[];
	const p = (yes: boolean) => ({ probability: yes ? 0.9 : 0.1 });
	return {
		answers: {
			durable: p(!fact.includes("[ephemeral]")),
			transient: p(fact.includes("[ephemeral]")),
			duplicate: p(related.some((r) => r.content === fact)),
			appropriateAudience: p(!fact.includes("[wrong-audience]")),
			sensitive: p(fact.includes("[secret]")),
			...Object.fromEntries(
				related.map((_, i) => [`supersedes_${i}`, p(fact.includes("[replaces]"))]),
			),
		},
	};
};

function slot(
	client: MnemonClient,
	audience: MemoryAudience,
	value: string[],
	events: MnemonEveEvent[] = [],
	evaluate: MemoryEvaluator = fakeEvaluate,
	recallFilter?: RecallFilter,
	enableForget?: boolean,
) {
	const provider = mnemonMemory({
		client,
		audience,
		gate: jevGate({ evaluate }),
		recallFilter,
		forget: enableForget,
		onEvent: (e) => events.push(e),
	});
	const memory = {
		slot: audience,
		scope: { key: `eve-key:${audience}:${value.join("/")}`, namespace: "app", value },
	};
	const turn = (text: string, operationId: string = crypto.randomUUID()) =>
		provider.recall["turn.started"]({
			memory,
			operationId,
			abortSignal: new AbortController().signal,
			turn: { id: "t", sequence: 1, input: [{ role: "user", content: text }] },
		} as never) as Promise<{ messages: { id: string; content: string }[] }>;
	const propose = async (fact: string, callId: string = crypto.randomUUID()) => {
		const tools = await provider.tools({
			memory,
			turn: { id: "t", sequence: 1, input: [{ role: "user", content: "remember this" }] },
		} as never);
		const tool = tools.propose_memory as unknown as {
			execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
		};
		return tool.execute({ fact }, { callId, abortSignal: new AbortController().signal });
	};
	const tools = () =>
		provider.tools({
			memory,
			turn: { id: "t", sequence: 1, input: [{ role: "user", content: "forget that" }] },
		} as never) as Promise<Record<string, unknown>>;
	const forget = async (id: string, callId: string = crypto.randomUUID()) => {
		const tool = (await tools()).forget_memory as {
			approval: unknown;
			execute(input: { id: string }, ctx: unknown): Promise<{ forgotten: boolean }>;
		};
		return tool.execute({ id }, { callId, abortSignal: new AbortController().signal });
	};
	return { turn, propose, tools, forget };
}

describe.skipIf(!available)("mnemonMemory", () => {
	it("stores accepted facts and recalls them in the same scope only", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			const orgA = slot(client, "organization", ["tenant-a"], events);
			const orgB = slot(client, "organization", ["tenant-b"]);
			const personalA1 = slot(client, "personal", ["tenant-a", "user-1"]);
			const personalA2 = slot(client, "personal", ["tenant-a", "user-2"]);
			const personalB1 = slot(client, "personal", ["tenant-b", "user-1"]);

			const fact = "Invoices are approved by the finance lead before payment";
			expect(await orgA.propose(fact)).toMatchObject({ status: "stored" });
			await personalA1.propose("User one prefers invoices summarised in a table");

			const hit = await orgA.turn("who approves invoices?");
			expect(hit.messages).toHaveLength(1);
			expect(hit.messages[0]?.content).toContain(fact);
			expect(hit.messages[0]?.content).toContain("not instructions");
			expect((await orgB.turn("who approves invoices?")).messages).toEqual([]);
			expect((await personalA2.turn("invoices table")).messages).toEqual([]);
			expect((await personalB1.turn("invoices table")).messages).toEqual([]);
			expect((await personalA1.turn("invoices table")).messages).toHaveLength(1);

			expect(JSON.stringify(events)).not.toContain("finance lead");
			expect(events.map((e) => e.type)).toEqual(["proposal", "recall"]);
		});
	});

	it("gates proposals and never stores rejected ones", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const org = slot(client, "organization", ["tenant-a"]);
			const stable = "The staging database is refreshed from production every Sunday";
			expect((await org.propose(stable)).status).toBe("stored");

			expect(await org.propose(stable)).toMatchObject({
				status: "rejected",
				reasons: ["duplicate"],
			});
			expect(await org.propose("Build 1234 is running now [ephemeral]")).toMatchObject({
				status: "rejected",
				reasons: expect.arrayContaining(["durable", "transient"]),
			});
			expect(await org.propose("Alice likes green tea [wrong-audience]")).toMatchObject({
				reasons: ["appropriateAudience"],
			});
			expect(await org.propose("The vault phrase is hunter2 [secret]")).toMatchObject({
				reasons: ["sensitive"],
			});

			let evaluated = 0;
			const counting = slot(client, "organization", ["tenant-a"], [], async (input) => {
				evaluated += 1;
				return fakeEvaluate(input);
			});
			expect(
				await counting.propose("Deploy key: password=CorrectHorseBattery"),
			).toEqual({ status: "rejected", reasons: ["sensitive"] });
			expect(evaluated).toBe(0);

			const recalled = await org.turn("staging production database hunter2 tea build");
			expect(recalled.messages.map((m) => m.content).join()).not.toMatch(/hunter2|tea|1234/);
		});
	});

	it("replays tool calls and recall operations without side effects", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			let evaluated = 0;
			const org = slot(client, "organization", ["tenant-a"], events, async (input) => {
				evaluated += 1;
				return fakeEvaluate(input);
			});
			const fact = "Support hours are 9 to 5 Central European Time";
			const first = await org.propose(fact, "call-1");
			const second = await org.propose(fact, "call-1");
			expect(second).toEqual(first);
			expect(evaluated).toBe(1);

			const before = await org.turn("support hours", "op-1");
			await org.propose("Support hours move to 8 to 4 in summer", "call-2");
			const replay = await org.turn("support hours", "op-1");
			expect(replay).toEqual(before);
			expect(events.filter((e) => e.replayed)).toHaveLength(2);
		});
	});

	it("forgets related memories the stored fact supersedes", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			const org = slot(client, "organization", ["tenant-a"], events);
			const other = slot(client, "organization", ["tenant-b"]);
			const old = await org.propose("Refunds are approved by the support lead");
			const kept = await other.propose("Refunds are approved by the support lead");

			const next = await org.propose("[replaces] Refunds are approved by the CFO");
			expect(next).toMatchObject({ status: "stored", superseded: [old.id] });
			expect(events.at(-1)).toMatchObject({ type: "proposal", superseded: 1 });

			const recalled = (await org.turn("who approves refunds?")).messages.map((m) => m.content);
			expect(recalled.join()).toContain("CFO");
			expect(recalled.join()).not.toContain("support lead");
			expect((await other.turn("who approves refunds?")).messages[0]?.content).toContain(
				"support lead",
			);
			expect(kept.status).toBe("stored");
		});
	});

	it("forgets a recalled memory only in its own partition when enabled", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			expect(Object.keys(await slot(client, "personal", ["tenant-a", "user-1"]).tools())).toEqual([
				"propose_memory",
			]);
			const mine = slot(client, "personal", ["tenant-a", "user-1"], events, fakeEvaluate, undefined, true);
			const theirs = slot(client, "personal", ["tenant-a", "user-2"], [], fakeEvaluate, undefined, true);
			const { id } = await mine.propose("User one prefers invoices summarised in a table");
			const recalled = (await mine.turn("invoices table")).messages[0]?.content;
			expect(recalled).toContain(id);
			expect((await mine.tools()).forget_memory).toHaveProperty("approval");

			expect(await theirs.forget(id!)).toEqual({ forgotten: false });
			expect(await mine.forget(id!, "call-1")).toEqual({ forgotten: true });
			expect(await mine.forget(id!, "call-1")).toEqual({ forgotten: true });
			expect((await mine.turn("invoices table")).messages).toEqual([]);
			expect(events.filter((e) => e.type === "forget")).toMatchObject([
				{ status: "forgotten", replayed: false },
				{ status: "forgotten", replayed: true },
			]);
		});
	});

	it("injects only memories the recall filter keeps and fails open", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			let shown = 0;
			let fail = false;
			const filter: RecallFilter = async ({ memories }) => {
				shown = memories.length;
				if (fail) throw new Error("filter down");
				return [...memories.filter((m) => !m.content.includes("soup")).map((m) => m.id), "not-a-hit"];
			};
			const org = slot(client, "organization", ["tenant-a"], events, fakeEvaluate, filter);
			await org.propose("Refunds over 500 euros need CFO approval");
			await org.propose("The cafeteria serves soup on Tuesdays");

			const kept = (await org.turn("who approves refunds?", "op-1")).messages;
			expect(kept.map((m) => m.content).join()).toContain("CFO");
			expect(kept.map((m) => m.content).join()).not.toContain("soup");
			expect(events.at(-1)).toMatchObject({ type: "recall", count: kept.length, candidates: shown });

			fail = true;
			expect(await org.turn("who approves refunds?", "op-1")).toEqual({ messages: kept });
			const open = (await org.turn("who approves refunds?", "op-2")).messages;
			expect(open.map((m) => m.content).join()).toContain("soup");
			expect(events.at(-1)).toMatchObject({ filterFailed: true });
		});
	});

	it("reads only user text from string and part content", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const org = slot(client, "organization", ["tenant-a"]);
			await org.propose("Refunds over 500 euros need CFO approval");
			const provider = mnemonMemory({ client, audience: "organization", gate: jevGate({ evaluate: fakeEvaluate }) });
			const recall = (input: unknown[]) =>
				provider.recall["turn.started"]({
					memory: { slot: "organization", scope: { key: "eve-key:organization:tenant-a", namespace: "app", value: ["tenant-a"] } },
					operationId: crypto.randomUUID(),
					abortSignal: new AbortController().signal,
					turn: { id: "t", sequence: 1, input },
				} as never) as Promise<{ messages: unknown[] }>;
			const parts = [
				{ role: "assistant", content: "unrelated" },
				{ role: "user", content: [{ type: "image", image: "x" }, { type: "text", text: "who approves refunds?" }] },
			];
			expect((await recall(parts)).messages).toHaveLength(1);
			expect((await recall([{ role: "assistant", content: "refunds CFO" }])).messages).toEqual([]);
		});
	});

	it("rethrows a recall filter error once the turn is aborted", async () => {
		await withMnemon({}, async (_m, { client }) => {
			await slot(client, "organization", ["tenant-a"]).propose("Refunds over 500 euros need CFO approval");
			const controller = new AbortController();
			const provider = mnemonMemory({
				client,
				audience: "organization",
				gate: jevGate({ evaluate: fakeEvaluate }),
				recallFilter: async () => {
					controller.abort();
					throw new Error("aborted");
				},
			});
			await expect(
				provider.recall["turn.started"]({
					memory: { slot: "organization", scope: { key: "eve-key:organization:tenant-a", namespace: "app", value: ["tenant-a"] } },
					operationId: crypto.randomUUID(),
					abortSignal: controller.signal,
					turn: { id: "t", sequence: 1, input: [{ role: "user", content: "who approves refunds?" }] },
				} as never),
			).rejects.toThrow("aborted");
		});
	});

	it("reports a duplicate the gate missed but Mnemon caught", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const provider = mnemonMemory({
				client,
				audience: "organization",
				gate: async () => ({ accept: true, reasons: [] }),
			});
			const memory = { slot: "organization", scope: { key: "eve-key:organization:tenant-a", namespace: "app", value: ["tenant-a"] } };
			const tools = await provider.tools({ memory, turn: { id: "t", sequence: 1, input: [] } } as never);
			const tool = tools.propose_memory as unknown as {
				execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
			};
			const propose = (fact: string) =>
				tool.execute({ fact }, { callId: crypto.randomUUID(), abortSignal: new AbortController().signal });
			const stored = await propose("Invoices are approved by the finance lead");
			expect(await propose("Invoices are approved by the finance lead")).toEqual({
				status: "duplicate",
				reasons: [],
				id: (stored as { id: string }).id,
			});
		});
	});

	it("defaults to the heuristic gate without a TypeSafe key", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", undefined);
		vi.stubEnv("TYPESAFE_AI_API_KEY", undefined);
		try {
			await withMnemon({}, async (_m, { client }) => {
				const provider = mnemonMemory({ client, audience: "organization" });
				const memory = { slot: "organization", scope: { key: "eve-key:organization:tenant-a", namespace: "app", value: ["tenant-a"] } };
				const tools = await provider.tools({ memory, turn: { id: "t", sequence: 1, input: [] } } as never);
				const tool = tools.propose_memory as unknown as {
					execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
				};
				expect(
					await tool.execute({ fact: "Thanks, that worked!" }, { callId: "c", abortSignal: new AbortController().signal }),
				).toMatchObject({ status: "rejected", reasons: ["durable"] });
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps memories across Eve key changes with a fixed namespace", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const provider = mnemonMemory({
				client,
				audience: "organization",
				gate: jevGate({ evaluate: fakeEvaluate }),
				namespace: "org-memory",
			});
			const memory = (key: string, tenant: string) => ({
				slot: "organization",
				scope: { key, namespace: "app", value: [tenant] },
			});
			const tools = await provider.tools({
				memory: memory("key-before-rename", "tenant-a"),
				turn: { id: "t", sequence: 1, input: [] },
			} as never);
			const tool = tools.propose_memory as unknown as {
				execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
			};
			await tool.execute(
				{ fact: "Refunds over 500 euros need CFO approval" },
				{ callId: "c", abortSignal: new AbortController().signal },
			);
			const recall = (key: string, tenant: string) =>
				provider.recall["turn.started"]({
					memory: memory(key, tenant),
					operationId: crypto.randomUUID(),
					abortSignal: new AbortController().signal,
					turn: { id: "t", sequence: 1, input: [{ role: "user", content: "who approves refunds?" }] },
				} as never) as Promise<{ messages: unknown[] }>;
			expect((await recall("key-after-rename", "tenant-a")).messages).toHaveLength(1);
			expect((await recall("key-after-rename", "tenant-b")).messages).toEqual([]);
		});
	});

	it("keeps personal memories per user in a shared fixed namespace", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			const provider = mnemonMemory({
				client,
				audience: "personal",
				gate: jevGate({ evaluate: fakeEvaluate }),
				namespace: "personal-memory",
				onEvent: (e) => events.push(e),
			});
			const memory = (user: string) => ({
				slot: "personal",
				scope: { key: `key-${user}`, namespace: "app", value: ["tenant-a", user] },
			});
			const propose = async (user: string, fact: string) => {
				const tools = await provider.tools({ memory: memory(user), turn: { id: "t", sequence: 1, input: [] } } as never);
				const tool = tools.propose_memory as unknown as {
					execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
				};
				// Same callId for both users: once keys must not collide.
				return tool.execute({ fact }, { callId: "c", abortSignal: new AbortController().signal });
			};
			const recall = (user: string) =>
				provider.recall["turn.started"]({
					memory: memory(user),
					operationId: "op",
					abortSignal: new AbortController().signal,
					turn: { id: "t", sequence: 1, input: [{ role: "user", content: "invoice format" }] },
				} as never) as Promise<{ messages: { content: string }[] }>;
			// The user policy (enforceUserScope, on by default) separates them.
			expect(await propose("user-1", "Prefers invoice summaries formatted as a table")).toMatchObject({ status: "stored" });
			expect(await propose("user-2", "Prefers invoice summaries formatted as bullets")).toMatchObject({ status: "stored" });
			expect((await recall("user-1")).messages.map((m) => m.content).join()).toContain("table");
			const two = (await recall("user-2")).messages.map((m) => m.content).join();
			expect(two).toContain("bullets");
			expect(two).not.toContain("table");
			expect((await recall("user-3")).messages).toEqual([]);
			expect(events.filter((e) => e.replayed)).toEqual([]);
		});
	});

	it("reports a failed proposal and records nothing", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const events: MnemonEveEvent[] = [];
			let fail = true;
			const provider = mnemonMemory({
				client,
				audience: "organization",
				gate: async () => {
					if (fail) throw new Error("gate down");
					return { accept: true, reasons: [] };
				},
				onEvent: (e) => events.push(e),
			});
			const memory = { slot: "organization", scope: { key: "k", namespace: "app", value: ["tenant-a"] } };
			const tools = await provider.tools({ memory, turn: { id: "t", sequence: 1, input: [] } } as never);
			const tool = tools.propose_memory as unknown as {
				execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
			};
			const propose = (fact: string) =>
				tool.execute({ fact }, { callId: "c", abortSignal: new AbortController().signal });
			const fact = "Refunds over 500 euros need CFO approval";
			await expect(propose(fact)).rejects.toThrow("gate down");
			expect(events.at(-1)).toMatchObject({ type: "proposal", status: "error" });
			fail = false;
			expect(await propose(fact)).toMatchObject({ status: "stored" });
			expect(await propose("   ")).toEqual({ status: "rejected", reasons: ["empty"] });
		});
	});

	it("rejects invalid limits", () => {
		for (const bad of [{ recallLimit: 0 }, { recallLimit: 101 }, { recallCharBudget: -1 }, { relatedLimit: 1.5 }, { relatedLimit: 101 }]) {
			expect(() =>
				mnemonMemory({ client: {} as MnemonClient, audience: "organization", gate: jevGate({ evaluate: fakeEvaluate }), ...bad }),
			).toThrow(RangeError);
		}
	});

	it("counts recall labels against the character budget", async () => {
		await withMnemon({}, async (_m, { client }) => {
			await slot(client, "organization", ["tenant-a"]).propose("Refunds over 500 euros need CFO approval");
			const provider = mnemonMemory({ client, audience: "organization", gate: jevGate({ evaluate: fakeEvaluate }), recallCharBudget: 120 });
			const { messages } = (await provider.recall["turn.started"]({
				memory: { slot: "organization", scope: { key: "eve-key:organization:tenant-a", namespace: "app", value: ["tenant-a"] } },
				operationId: crypto.randomUUID(),
				abortSignal: new AbortController().signal,
				turn: { id: "t", sequence: 1, input: [{ role: "user", content: "who approves refunds?" }] },
			} as never)) as { messages: { content: string }[] };
			expect(messages).toHaveLength(1);
			expect(messages[0]!.content.length).toBeLessThanOrEqual(120);
		});
	});

	it("rejects an invalid fixed namespace", () => {
		for (const namespace of ["", " padded", "x".repeat(201)]) {
			expect(() =>
				mnemonMemory({ client: {} as MnemonClient, audience: "organization", namespace, gate: jevGate({ evaluate: fakeEvaluate }) }),
			).toThrow(/namespace must be/);
		}
	});

	it("throws when a slot's scope does not match its audience", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const wrong = slot(client, "personal", ["tenant-a"]);
			await expect(wrong.turn("anything")).rejects.toThrow(/tenantId, userId/);
			await expect(wrong.propose("anything")).rejects.toThrow(/tenantId, userId/);
		});
	});
});
