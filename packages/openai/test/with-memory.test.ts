import { Agent, RunContext } from "@openai/agents";
import { describe, expect, it } from "vitest";

import { createMnemonMemory, MNEMON_MEMORY_INSTRUCTIONS, withMnemonMemory } from "../src/index.js";
import { hit, mockClient } from "./helpers.js";

interface Ctx {
	tenantId: string;
	userId: string;
}

describe("withMnemonMemory", () => {
	it("merges tools for two audiences without mutating the source agent", async () => {
		const client = mockClient({
			recall: async () => [hit("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Org fact")],
		});
		const org = createMnemonMemory<Ctx>({
			client,
			audience: "organization",
			namespace: "app",
			resolveAuth: (rc) => ({ tenantId: rc.context.tenantId }),
			gate: async () => ({ accept: true, reasons: [] }),
		});
		const personal = createMnemonMemory<Ctx>({
			client,
			audience: "personal",
			namespace: "app",
			resolveAuth: (rc) => ({
				tenantId: rc.context.tenantId,
				userId: rc.context.userId,
			}),
			gate: async () => ({ accept: true, reasons: [] }),
		});
		const original = new Agent<Ctx>({
			name: "Support",
			instructions: "Be helpful.",
			tools: [],
		});
		const wired = withMnemonMemory(original, [org, personal]);

		expect(original.tools).toHaveLength(0);
		expect(wired).not.toBe(original);
		expect(wired.tools.map((t) => ("name" in t ? t.name : ""))).toEqual([
			"propose_organization_memory",
			"propose_personal_memory",
		]);

		const rc = new RunContext<Ctx>({ tenantId: "acme", userId: "u1" });
		wired.emit(
			"agent_start",
			rc,
			wired,
			[{ role: "user", content: [{ type: "input_text", text: "policy?" }] }],
		);
		const instructions =
			typeof wired.instructions === "function"
				? await wired.instructions(rc, wired)
				: wired.instructions;
		expect(instructions).toContain("Be helpful.");
		expect(instructions).toContain(MNEMON_MEMORY_INSTRUCTIONS);
		expect(instructions.split(MNEMON_MEMORY_INSTRUCTIONS).length - 1).toBe(1);
		expect(instructions).toContain("Org fact");
	});
});
