import type { AgentInputItem } from "@openai/agents";

/**
 * Latest user-visible text from a run input, for Mnemon recall queries.
 * Scans from the end so session history does not bury the current turn.
 */
export function latestUserText(input: string | AgentInputItem[]): string {
	if (typeof input === "string") return input.trim();

	for (let i = input.length - 1; i >= 0; i--) {
		const item = input[i];
		if (!item || !("role" in item) || item.role !== "user") continue;
		const content = item.content;
		if (typeof content === "string") {
			const text = content.trim();
			if (text) return text;
			continue;
		}
		if (!Array.isArray(content)) continue;
		const parts: string[] = [];
		for (const part of content) {
			if (part.type === "input_text") parts.push(part.text);
			else if (part.type === "audio" && part.transcript) parts.push(part.transcript);
		}
		const text = parts.join("\n").trim();
		if (text) return text;
	}
	return "";
}
