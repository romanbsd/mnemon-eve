import type { AgentInputItem } from "@openai/agents";
import { describe, expect, it } from "vitest";

import { latestUserText } from "../src/input.js";

describe("latestUserText", () => {
	it("returns trimmed string input", () => {
		expect(latestUserText("  hello  ")).toBe("hello");
	});

	it("takes the latest user message from item arrays", () => {
		const items = [
			{ role: "user", content: [{ type: "input_text", text: "first" }] },
			{
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
			{ role: "user", content: [{ type: "input_text", text: "second" }] },
		] as AgentInputItem[];
		expect(latestUserText(items)).toBe("second");
	});

	it("joins multimodal user parts and skips empty turns", () => {
		const items = [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Look:" },
					{ type: "input_image", image: "https://example.com/a.png" },
					{ type: "audio", audio: "AAAA", transcript: "spoken note" },
				],
			},
		] as AgentInputItem[];
		expect(latestUserText(items)).toBe("Look:\nspoken note");
	});

	it("returns empty when there is no user text", () => {
		expect(latestUserText([])).toBe("");
		expect(
			latestUserText([
				{
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "hi" }],
				},
			] as AgentInputItem[]),
		).toBe("");
	});
});
