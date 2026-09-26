import {
	AUDIENCE_DESCRIPTIONS,
	type GateFlag,
	type MemoryAudience,
	type MemoryGate,
} from "../src/index.js";

/** Labeled proposal: `reject` names the flag a careful reviewer would reject it for. */
export interface GateCase {
	fact: string;
	audience: MemoryAudience;
	related?: string[];
	reject?: GateFlag;
}

const o = "organization" as const;
const p = "personal" as const;

// Written as a reviewer would label them, before tuning the heuristic.
export const GATE_CASES: GateCase[] = [
	// Accept: durable, new, right audience.
	{ audience: o, fact: "Refunds over $500 must be approved by the head of support." },
	{ audience: o, fact: "The billing service is owned by the payments team." },
	{ audience: o, fact: "We deploy to production only on Tuesdays and Thursdays." },
	{ audience: o, fact: "Customer data must stay in the EU region for GDPR compliance." },
	{ audience: o, fact: "Our support SLA for enterprise customers is four business hours." },
	{ audience: o, fact: "The company decided to standardize on PostgreSQL for new services." },
	{ audience: o, fact: "Invoices are generated on the first business day of each month." },
	{ audience: o, fact: "Acme Corp is our largest customer and has a dedicated account manager, Priya." },
	{ audience: o, fact: "Staging mirrors production data nightly with personal fields masked." },
	{ audience: o, fact: "All pull requests need one approving review before merge." },
	{ audience: o, fact: "The mobile app release branch is cut every second Friday." },
	{ audience: o, fact: "Vendor contracts above $10k go through legal review." },
	{ audience: p, fact: "I prefer answers as short bullet lists." },
	{ audience: p, fact: "Dana is allergic to peanuts." },
	{ audience: p, fact: "My manager is Luis Ortega." },
	{ audience: p, fact: "I work from Lisbon, in the WET time zone." },
	{ audience: p, fact: "The user prefers TypeScript examples over Python." },
	{ audience: p, fact: "I am responsible for the billing service on-call rotation." },
	{ audience: p, fact: "Sam likes meetings scheduled after 10am." },
	{ audience: p, fact: "My daughter's name is Maya." },
	{ audience: p, fact: "I use Neovim with the LazyVim setup." },
	{ audience: p, fact: "I never want calendar invites on Fridays." },

	// Reject: transient task state.
	{ audience: o, reject: "transient", fact: "The export is running right now and is 40% done." },
	{ audience: o, reject: "transient", fact: "Build 48213 failed on the lint step." },
	{ audience: p, reject: "transient", fact: "I am currently on step 3 of 5 of the onboarding wizard." },
	{ audience: p, reject: "transient", fact: "I'm waiting for the upload to finish." },
	{ audience: o, reject: "transient", fact: "The deploy is in progress on staging." },
	{ audience: p, reject: "transient", fact: "Today I'm working on the invoice PDF bug." },
	{ audience: o, reject: "transient", fact: "Production is down at the moment." },
	{ audience: p, reject: "transient", fact: "I have a dentist appointment this afternoon." },

	// Reject: not durable (chatter, questions, trivia).
	{ audience: p, reject: "durable", fact: "Thanks, that worked!" },
	{ audience: p, reject: "durable", fact: "Can you check the logs?" },
	{ audience: o, reject: "durable", fact: "ok" },
	{ audience: p, reject: "durable", fact: "What time is it in Tokyo?" },
	{ audience: p, reject: "durable", fact: "Hello there" },
	{ audience: o, reject: "durable", fact: "Sounds good, let's do that." },

	// Reject: duplicates of related memories.
	{
		audience: o,
		reject: "duplicate",
		fact: "The billing service is owned by the payments team.",
		related: ["The billing service is owned by the payments team."],
	},
	{
		audience: p,
		reject: "duplicate",
		fact: "I prefer short bullet lists.",
		related: ["User prefers answers as short bullet lists."],
	},
	{
		audience: o,
		reject: "duplicate",
		fact: "Deploys to production happen on Tuesdays and Thursdays.",
		related: ["We deploy to production only on Tuesdays and Thursdays."],
	},
	{
		audience: p,
		reject: "duplicate",
		fact: "Dana is allergic to peanuts",
		related: ["Dana is allergic to peanuts.", "Dana works from Berlin."],
	},
	{
		audience: o,
		reject: "duplicate",
		fact: "PRs need one approving review before merging.",
		related: ["All pull requests need one approving review before merge."],
	},

	// Accept despite related memories: new information on the same subject.
	{
		audience: o,
		fact: "Refunds over $500 must now be approved by the CFO.",
		related: ["Refunds over $500 must be approved by the head of support."],
	},
	{
		audience: p,
		fact: "Dana is also allergic to shellfish.",
		related: ["Dana is allergic to peanuts."],
	},
	{
		audience: o,
		fact: "The billing service runs on Node 24.",
		related: ["The billing service is owned by the payments team."],
	},

	// Reject: wrong audience.
	{ audience: o, reject: "appropriateAudience", fact: "I prefer dark mode in every tool." },
	{ audience: o, reject: "appropriateAudience", fact: "My wife's birthday is March 3." },
	{ audience: o, reject: "appropriateAudience", fact: "Sam likes his coffee black." },
	{ audience: p, reject: "appropriateAudience", fact: "Our company policy is that laptops must use disk encryption." },
	{ audience: p, reject: "appropriateAudience", fact: "The payments team owns the billing service." },
	{ audience: p, reject: "appropriateAudience", fact: "We release the mobile app every second Friday." },

	// Reject: sensitive.
	{ audience: p, reject: "sensitive", fact: "My bank PIN is 4821." },
	{ audience: p, reject: "sensitive", fact: "The alarm code for my house is 7 7 1 9 0." },
	{ audience: o, reject: "sensitive", fact: "The office door code is 55120." },
	{ audience: p, reject: "sensitive", fact: "My card number is 4111 1111 1111 1111." },
	{ audience: o, reject: "sensitive", fact: "Staging API key: sk-live_9fX2aQ7rT4mP8wZ1bC3dE5" },
	{ audience: p, reject: "sensitive", fact: "My wifi password is hunter2hunter2." },
	{ audience: o, reject: "sensitive", fact: "The recovery code for the admin account is K7PQ2M9XW4RT." },
	{ audience: p, reject: "sensitive", fact: "My passphrase is correct horse battery staple 42." },
];

export interface GateScore {
	correct: number;
	total: number;
	/** Rejections the gate accepted. */
	missedRejects: number;
	/** Acceptable facts the gate rejected. */
	falseRejects: number;
	/** Facts of the cases the gate got wrong. */
	misses: string[];
}

export async function scoreGate(gate: MemoryGate, cases = GATE_CASES): Promise<GateScore> {
	const score: GateScore = { correct: 0, total: cases.length, missedRejects: 0, falseRejects: 0, misses: [] };
	for (const c of cases) {
		const decision = await gate({
			fact: c.fact,
			audience: c.audience,
			audienceDescription: AUDIENCE_DESCRIPTIONS[c.audience],
			recentContext: "",
			relatedMemories: (c.related ?? []).map((content, i) => ({ id: String(i), content })),
		});
		const expectAccept = c.reject === undefined;
		if (decision.accept === expectAccept) {
			score.correct += 1;
			continue;
		}
		score.misses.push(c.fact);
		if (expectAccept) score.falseRejects += 1;
		else score.missedRejects += 1;
	}
	return score;
}
