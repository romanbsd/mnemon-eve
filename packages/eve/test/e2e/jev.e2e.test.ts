import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { MnemonClient } from "@mnemon/core";
import { describe, expect, it } from "vitest";

import { postgresAvailable, withMnemon } from "../../../core/test/integration/helpers.js";
import {
	jevGate,
	type MemoryAudience,
	type MemoryGate,
	mnemonMemory,
	type ProposalResult,
} from "../../src/index.js";

const apiKey = process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY;
const available = Boolean(apiKey) && (await postgresAvailable());

const jev = jevGate({ model: createTypeSafeAi({ apiKey }).evaluationModel("jev-latest") });

function slot(client: MnemonClient, audience: MemoryAudience, value: string[], gate: MemoryGate = jev) {
	const provider = mnemonMemory({ client, audience, gate });
	const memory = {
		slot: audience,
		scope: { key: `e2e:${audience}:${value.join("/")}`, namespace: "e2e", value },
	};
	const turn = (text: string) =>
		provider.recall["turn.started"]({
			memory,
			operationId: crypto.randomUUID(),
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
