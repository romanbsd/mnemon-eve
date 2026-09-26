const BASE: Record<number, number> = {
	5: 1,
	4: 0.8,
	3: 0.5,
	2: 0.3,
	1: 0.15,
};

/** High-importance or frequently accessed memories are never retention candidates. */
export function isImmune(importance: number, accessCount: number): boolean {
	return importance >= 4 || accessCount >= 3;
}

export function effectiveImportance(input: {
	importance: number;
	accessCount: number;
	daysSinceAccess: number;
	edgeCount: number;
}): number {
	const base = BASE[input.importance] ?? 0.15;
	const accessFactor = Math.max(1, Math.log1p(input.accessCount));
	const decayFactor = 0.5 ** (input.daysSinceAccess / 30);
	const edgeFactor = 1 + 0.1 * Math.min(input.edgeCount, 5);
	return base * accessFactor * decayFactor * edgeFactor;
}
