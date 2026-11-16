import type {
	Agent,
	AgentOutputType,
	RunContext,
	TextOutput,
	UnknownContext,
} from "@openai/agents";
import { MNEMON_MEMORY_INSTRUCTIONS } from "@romanbsd/mnemon-eve/gates";

import type { AgentInstructions, MnemonAgentsMemory } from "./memory.js";

/**
 * Clone an agent with Mnemon tools and dynamic instructions that inject
 * recalled memories. Attaches `onAgentStart` so recall warms before instructions
 * run. Does not mutate the original agent or attach a Session.
 */
export function withMnemonMemory<
	TContext = UnknownContext,
	TOutput extends AgentOutputType = TextOutput,
>(
	agent: Agent<TContext, TOutput>,
	memory: MnemonAgentsMemory<TContext> | MnemonAgentsMemory<TContext>[],
): Agent<TContext, TOutput> {
	const memories = Array.isArray(memory) ? memory : [memory];
	if (memories.length === 0) {
		return agent.clone({});
	}

	const tools = [...agent.tools, ...memories.flatMap((m) => m.tools)];
	const base = agent.instructions as AgentInstructions<TContext, TOutput>;

	const [first, ...rest] = memories;
	const instructions =
		rest.length === 0 && first
			? first.buildInstructions(base)
			: async (runContext: RunContext<TContext>, agentInstance: Agent<TContext, TOutput>) => {
					const baseText =
						typeof base === "function" ? await base(runContext, agentInstance) : base;
					const recalls = await Promise.all(memories.map((m) => m.cachedRecall(runContext)));
					return [baseText, MNEMON_MEMORY_INSTRUCTIONS, ...recalls.filter(Boolean)]
						.filter(Boolean)
						.join("\n\n");
				};

	const cloned = agent.clone({ tools, instructions });
	for (const m of memories) {
		cloned.on("agent_start", m.onAgentStart);
	}
	return cloned;
}
