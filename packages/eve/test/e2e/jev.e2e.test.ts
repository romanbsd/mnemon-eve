import type { MnemonClient } from "@romanbsd/mnemon-core";
import { describe, expect, it } from "vitest";

import { postgresAvailable, withMnemon } from "../../../core/test/integration/helpers.js";
import { scoreGate } from "../gate-benchmark.js";
import {
	heuristicGate,
	jevGate,
	jevRecallFilter,
	type MemoryAudience,
	type MemoryGate,
	mnemonMemory,
	type ProposalResult,
	typesafeModel,
} from "../../src/index.js";

const available = typesafeModel() !== undefined && (await postgresAvailable());

const jev = jevGate();

const recallFilter = jevRecallFilter();

function slot(
	client: MnemonClient,
	audience: MemoryAudience,
	value: string[],
	gate: MemoryGate = jev,
	filtered = false,
) {
	const provider = mnemonMemory({ client, audience, gate, ...(filtered ? { recallFilter } : {}) });
	const memory = {
		slot: audience,
		scope: { key: `e2e:${audience}:${value.join("/")}`, namespace: "e2e", value },
	};
	const turn = (text: string) =>
		provider.recall["turn.started"]({
			memory,
			operationId: crypto.randomUUID(),
			abortSignal: new AbortController().signal,
			turn: { id: "t", sequence: 1, input: [{ role: "user", content: text }] },
		} as never) as Promise<{ messages: { id: string; content: string }[] }>;
	const propose = async (fact: string, callId: string = crypto.randomUUID()) => {
		const tools = await provider.tools({
			memory,
			turn: { id: "t", sequence: 1, input: [{ role: "user", content: fact }] },
		} as never);
		const tool = tools.propose_memory as unknown as {
			execute(input: { fact: string }, ctx: unknown): Promise<ProposalResult>;
		};
		return tool.execute({ fact }, { callId, abortSignal: new AbortController().signal });
	};
	return { turn, propose };
}

// Real TypeSafe Jev + Postgres under RLS. Assertions use clear-cut facts;
// Jev is probabilistic, so borderline phrasing may flip.
describe.skipIf(!available)("jevGate end to end", { timeout: 60_000 }, () => {
	it("scores at least as well as the heuristic gate on the labeled benchmark", async () => {
		const [jevScore, heuristic] = await Promise.all([scoreGate(jev), scoreGate(heuristicGate())]);
		console.log({ jev: jevScore, heuristic: heuristic.correct });
		expect(jevScore.correct).toBeGreaterThanOrEqual(heuristic.correct);
	}, 300_000);

	it("stores durable organization knowledge, classifies it, and isolates tenants", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const orgA = slot(client, "organization", ["tenant-a"]);
			const orgB = slot(client, "organization", ["tenant-b"]);
			const fact =
				"Refunds over 500 euros must be approved by the head of customer support before they are issued";

			const result = await orgA.propose(fact);
			expect(result).toMatchObject({ status: "stored", reasons: [] });

			const stored = await client
				.scope({ tenantId: "tenant-a", namespace: "e2e:organization:tenant-a" })
				.get(result.id as string);
			console.log("classified as", stored?.category, "importance", stored?.importance);
			expect(stored?.importance).toBeGreaterThanOrEqual(3);

			const hit = await orgA.turn("who approves large refunds?");
			expect(hit.messages.map((m) => m.content).join()).toContain("head of customer support");
			expect((await orgB.turn("who approves large refunds?")).messages).toEqual([]);
		});
	});

	it("replaces a memory the new fact contradicts", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const org = slot(client, "organization", ["tenant-a"]);
			const old = await org.propose(
				"Refunds over 500 euros must be approved by the head of customer support",
			);
			expect(old.status).toBe("stored");
			const unrelated = await org.propose(
				"Refunds are paid back to the original payment method within 10 business days",
			);
			expect(unrelated.status).toBe("stored");

			const next = await org.propose(
				"Since the March reorganisation, refunds over 500 euros must be approved by the CFO instead of the head of customer support",
			);
			console.log("contradiction:", next);
			expect(next).toMatchObject({ status: "stored", superseded: [old.id] });

			const recalled = (await org.turn("who approves large refunds?")).messages
				.map((m) => m.content)
				.join();
			expect(recalled).toContain("CFO");
			expect(recalled).not.toContain("must be approved by the head of customer support");
			expect(recalled).toContain("10 business days");
		});
	});

	it("filters recall to memories that help the turn", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const personal = slot(client, "personal", ["tenant-a", "dana"], jev, true);
			for (const fact of [
				"Dana prefers answers as short bullet lists without emojis",
				"Dana's team owns the billing service",
				"Dana is allergic to peanuts",
			]) {
				expect((await personal.propose(fact)).status).toBe("stored");
			}
			const recalled = (await personal.turn("Summarise the open billing service incidents for me")).messages
				.map((m) => m.content)
				.join();
			console.log("filtered recall:", recalled.replace(/Recalled[^\n]*\n/g, "| "));
			expect(recalled).toContain("billing service");
			expect(recalled).toContain("bullet lists");
			expect(recalled).not.toContain("peanuts");
		});
	});

	it("rejects transient task state", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const org = slot(client, "organization", ["tenant-a"]);
			const result = await org.propose(
				"I am currently on step 3 of 5 of exporting today's CSV report; the upload is at 40 percent",
			);
			expect(result.status).toBe("rejected");
			expect(result.reasons).toContain("transient");
		});
	});

	it("does not store a paraphrased duplicate", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const org = slot(client, "organization", ["tenant-a"]);
			expect(
				(await org.propose("The production database is backed up every night at 2 AM UTC")).status,
			).toBe("stored");
			const again = await org.propose(
				"Every night at 02:00 UTC a backup of the production database is taken",
			);
			expect(again.status).not.toBe("stored");
		});
	});

	it("routes personal preferences to the personal slot only", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const preference = "Dana prefers answers as short bullet lists without emojis";
			const org = slot(client, "organization", ["tenant-a"]);
			const personal = slot(client, "personal", ["tenant-a", "dana"]);

			const orgResult = await org.propose(preference);
			expect(orgResult.status).toBe("rejected");
			expect(orgResult.reasons).toContain("appropriateAudience");
			expect((await personal.propose(preference)).status).toBe("stored");
		});
	});

	it("rejects secrets that slip past the regex pre-filter", async () => {
		await withMnemon({}, async (_m, { client }) => {
			const org = slot(client, "organization", ["tenant-a"]);
			const result = await org.propose(
				"The alarm code for the Berlin office front door is 4-8-2-1-9",
			);
			expect(result.status).toBe("rejected");
			expect(result.reasons).toContain("sensitive");
		});
	});

	it("replays a tool call without asking Jev again", async () => {
		await withMnemon({}, async (_m, { client }) => {
			let calls = 0;
			const counted: MemoryGate = (input) => {
				calls += 1;
				return jev(input);
			};
			const org = slot(client, "organization", ["tenant-a"], counted);
			const fact = "Customer support is staffed from 8 AM to 6 PM Central European Time on weekdays";
			const first = await org.propose(fact, "call-1");
			const replay = await org.propose(fact, "call-1");
			expect(replay).toEqual(first);
			expect(calls).toBe(1);
		});
	});
});
