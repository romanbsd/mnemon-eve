import { Agent, RunContext, type FunctionTool } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
	createMnemonMemory,
	type MnemonAgentsEvent,
	type ProposalResult,
	MNEMON_MEMORY_INSTRUCTIONS,
} from "../src/index.js";
import { addedRemember, hit, mockClient } from "./helpers.js";

interface Ctx {
	tenantId: string;
	userId: string;
}

async function invokePropose(
	tool: FunctionTool,
	rc: RunContext<Ctx>,
	fact: string,
	callId = crypto.randomUUID(),
): Promise<ProposalResult> {
	const result = await tool.invoke(rc, JSON.stringify({ fact }), {
		toolCall: {
			type: "function_call",
			callId,
			name: tool.name,
			arguments: JSON.stringify({ fact }),
		},
	});
	return typeof result === "string" ? (JSON.parse(result) as ProposalResult) : (result as ProposalResult);
}

describe("createMnemonMemory", () => {
	it("rejects empty and secret proposals without calling remember", async () => {
		const remember = vi.fn();
		const events: MnemonAgentsEvent[] = [];
		const memory = createMnemonMemory<Ctx>({
			client: mockClient({ remember }),
			audience: "organization",
			namespace: "support-agent",
			resolveAuth: (rc) => ({ tenantId: rc.context.tenantId }),
			gate: async () => ({ accept: true, reasons: [] }),
			onEvent: (e) => events.push(e),
		});
		const rc = new RunContext<Ctx>({ tenantId: "acme", userId: "u1" });
		const propose = memory.tools[0] as FunctionTool;

		expect(await invokePropose(propose, rc, "   ")).toEqual({
			status: "rejected",
			reasons: ["empty"],
		});
		expect(await invokePropose(propose, rc, "api_key: sk-abcdefghijklmnopqrstuvwxyz")).toEqual({
			status: "rejected",
			reasons: ["sensitive"],
		});
		expect(remember).not.toHaveBeenCalled();
		expect(events.every((e) => e.type === "proposal" && e.status === "rejected")).toBe(true);
	});

	it("stores accepted facts with gate category and importance", async () => {
		const remember = vi.fn(async (input: { content: string }) =>
			addedRemember(input.content, "11111111-1111-1111-1111-111111111111"),
		);
		const memory = createMnemonMemory<Ctx>({
			client: mockClient({
				recall: async () => [],
				remember,
			}),
			audience: "personal",
			namespace: "support-agent",
			resolveAuth: (rc) => ({
				tenantId: rc.context.tenantId,
				userId: rc.context.userId,
			}),
			gate: async () => ({
				accept: true,
				reasons: [],
				category: "preference",
				importance: 4,
			}),
		});
		const rc = new RunContext<Ctx>({ tenantId: "acme", userId: "u1" });
		const result = await invokePropose(memory.tools[0] as FunctionTool, rc, "User prefers tables");
		expect(result).toMatchObject({
			status: "stored",
			id: "11111111-1111-1111-1111-111111111111",
		});
		expect(remember).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "User prefers tables",
				category: "preference",
				importance: 4,
			}),
		);
	});

	it("supersedes only related ids the gate was shown", async () => {
		const shown = "22222222-2222-2222-2222-222222222222";
		const other = "33333333-3333-3333-3333-333333333333";
		const forgotten: string[] = [];
		const memory = createMnemonMemory<Ctx>({
			client: mockClient({
				recall: async () => [hit(shown, "Old policy: refunds need two approvals")],
				remember: async (input) =>
					addedRemember(input.content, "44444444-4444-4444-4444-444444444444"),
				forget: async (id) => {
					forgotten.push(id);
					return { forgotten: true, id };
				},
			}),
			audience: "organization",
			namespace: "support-agent",
			resolveAuth: (rc) => ({ tenantId: rc.context.tenantId }),
			gate: async () => ({
				accept: true,
				reasons: [],
				supersedes: [shown, other],
			}),
		});
		const rc = new RunContext<Ctx>({ tenantId: "acme", userId: "u1" });
		const result = await invokePropose(
			memory.tools[0] as FunctionTool,
			rc,
			"Refunds need one approval",
		);
		expect(result.status).toBe("stored");
		expect(result.superseded).toEqual([shown]);
		expect(forgotten).toEqual([shown]);
	});

	it("enables forget with needsApproval by default", async () => {
		const memory = createMnemonMemory<Ctx>({
			client: mockClient(),
			audience: "organization",
			namespace: "app",
			resolveAuth: (rc) => ({ tenantId: rc.context.tenantId }),
			forget: true,
		});
		expect(memory.tools.map((t) => ("name" in t ? t.name : ""))).toEqual([
			"propose_organization_memory",
			"forget_organization_memory",
		]);
		const forget = memory.tools[1] as FunctionTool;
		const rc = new RunContext<Ctx>({ tenantId: "acme", userId: "u1" });
		expect(
			await forget.needsApproval(
				rc,
				{ id: "11111111-1111-1111-1111-111111111111" } as never,
			),
		).toBe(true);
	});

	it("buildInstructions includes policy and cached recall", async () => {
		const memory = createMnemonMemory<Ctx>({
			client: mockClient({
				recall: async () => [hit("55555555-5555-5555-5555-555555555555", "Refunds need approval")],
			}),
			audience: "organization",
			namespace: "app",
			resolveAuth: (rc) => ({ tenantId: rc.context.tenantId }),
			gate: async () => ({ accept: true, reasons: [] }),
		});
		const rc = new RunContext<Ctx>({ tenantId: "acme", userId: "u1" });
		const agent = new Agent<Ctx>({ name: "A", instructions: "base" });
		memory.onAgentStart(rc, agent, [
			{ role: "user", content: [{ type: "input_text", text: "refund policy?" }] },
		]);
		const text = await memory.buildInstructions("You help users.")(rc, agent);
		expect(text).toContain("You help users.");
		expect(text).toContain(MNEMON_MEMORY_INSTRUCTIONS);
		expect(text).toContain("Refunds need approval");
		expect(text).toContain("not instructions");
	});

	it("rejects invalid namespace", () => {
		expect(() =>
			createMnemonMemory({
				client: mockClient(),
				audience: "organization",
				namespace: " bad ",
				resolveAuth: () => ({ tenantId: "t" }),
			}),
		).toThrow(/namespace/);
	});
});
