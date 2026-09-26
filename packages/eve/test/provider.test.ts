import type { MnemonClient } from "@mnemon/core";
import { describe, expect, it } from "vitest";

import { postgresAvailable, withMnemon } from "../../core/test/integration/helpers.js";
import {
	type MemoryAudience,
	type MemoryEvaluator,
	type MnemonEveEvent,
	mnemonMemory,
	jevGate,
	type ProposalResult,
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
) {
	const provider = mnemonMemory({
		client,
		audience,
		gate: jevGate({ evaluate }),
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
	return { turn, propose };
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

	it("throws when a slot's scope does not match its audience", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const wrong = slot(client, "personal", ["tenant-a"]);
			await expect(wrong.turn("anything")).rejects.toThrow(/tenantId, userId/);
			await expect(wrong.propose("anything")).rejects.toThrow(/tenantId, userId/);
		});
	});
});
