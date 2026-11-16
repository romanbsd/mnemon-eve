import type {
	Insight,
	MnemonClient,
	RecallHit,
	RememberResult,
} from "@romanbsd/mnemon-core";

export function insight(id: string, content: string): Insight {
	return {
		id,
		content,
		category: "fact",
		importance: 3,
		tags: [],
		entities: [],
		source: "agent",
		metadata: {},
		accessCount: 0,
		storedAt: "2026-01-15T00:00:00.000Z",
		createdAt: "2026-01-15T00:00:00.000Z",
		updatedAt: "2026-01-15T00:00:00.000Z",
	};
}

export function hit(id: string, content: string): RecallHit {
	return {
		insight: insight(id, content),
		score: 1,
		intent: "GENERAL",
		matchedVia: "keyword",
		signals: {
			keyword: 1,
			entity: 0,
			similarity: 0,
			graph: 0,
		},
	};
}

export function addedRemember(content: string, id = crypto.randomUUID()): RememberResult {
	return {
		action: "added",
		insight: insight(id, content),
		suggestion: "ADD",
		diff: [],
		semanticCandidates: [],
		edgeCounts: {
			temporal: 0,
			semantic: 0,
			causal: 0,
			entity: 0,
		},
	};
}

export function mockClient(overrides: {
	recall?: (query: string) => Promise<RecallHit[]>;
	remember?: (input: {
		content: string;
		category?: string;
		importance?: number;
	}) => Promise<RememberResult>;
	forget?: (id: string) => Promise<{ forgotten: boolean; id: string }>;
} = {}): MnemonClient {
	const onceStore = new Map<string, unknown>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
	const tx: any = {
		async recall({ query }: { query: string }) {
			return {
				results: (await overrides.recall?.(query)) ?? [],
				meta: {
					intent: "GENERAL",
					intentSource: "auto",
					anchorCount: 0,
					traversed: 0,
					algorithmVersion: "mnemon-ts-v1",
				},
			};
		},
		async remember(input: { content: string; category?: string; importance?: number }) {
			if (overrides.remember) return overrides.remember(input);
			return addedRemember(input.content);
		},
		async forget(id: string) {
			const result = await overrides.forget?.(id);
			return result ?? { forgotten: true, id };
		},
		async once(key: string, fn: (m: unknown) => Promise<unknown>) {
			if (onceStore.has(key)) {
				return { value: onceStore.get(key), replayed: true };
			}
			const value = await fn(tx);
			onceStore.set(key, value);
			return { value, replayed: false };
		},
	};

	return {
		initialize: async () => {},
		close: async () => {},
		scope: () => tx as unknown,
		withAuthorization: async (_auth: unknown, fn: (m: unknown) => Promise<unknown>) =>
			fn(tx as unknown),
	} as unknown as MnemonClient;
}
