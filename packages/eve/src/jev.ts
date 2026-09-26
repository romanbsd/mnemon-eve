import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { evaluate } from "eve/ai";

export type JevModel = NonNullable<Parameters<typeof evaluate>[0]["model"]>;

/**
 * Subset of `evaluate` from `eve/ai` that the Jev gate, recall filter, and
 * judges need; inject a fake in tests.
 */
export type JevEvaluator<Question, Answer> = (options: {
	state: Record<string, unknown>;
	questions: Record<string, Question>;
	abortSignal?: AbortSignal;
}) => Promise<{ answers: Record<string, Answer | undefined> }>;

/**
 * TypeSafe Jev called directly when `TYPESAFE_API_KEY` (or the SDK's
 * `TYPESAFE_AI_API_KEY`) is set; otherwise undefined, so `evaluate` falls
 * back to `typesafe-ai/jev` via Vercel AI Gateway.
 */
export function typesafeModel(): JevModel | undefined {
	const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_AI_API_KEY;
	return apiKey
		? createTypeSafeAi({ apiKey }).evaluationModel("jev-latest")
		: undefined;
}

/** `evaluate` bound to `model`, defaulting to `typesafeModel()`. */
export function jevEvaluator<Question, Answer>(
	model: JevModel | undefined = typesafeModel(),
): JevEvaluator<Question, Answer> {
	return (input) =>
		evaluate({
			...input,
			state: input.state as never,
			questions: input.questions as never,
			model,
		});
}
