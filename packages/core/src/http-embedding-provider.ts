import type { EmbeddingProvider } from "./embedding-provider.js";
import { MnemonEmbeddingError } from "./errors.js";

export const NOMIC_EMBED_TEXT_DIMENSIONS = 768;

export const EMBEDDING_PROTOCOLS = ["llamacpp", "openai", "ollama"] as const;
export type EmbeddingProtocol = (typeof EMBEDDING_PROTOCOLS)[number];

export interface HttpEmbeddingProviderOptions {
	endpoint?: string;
	model?: string;
	dimensions?: number;
	apiKey?: string;
	protocol?: EmbeddingProtocol;
	timeoutMs?: number;
}

type Purpose = "document" | "query";

interface ProtocolSpec {
	label: string;
	defaultEndpoint: string;
	defaultDimensions: number;
	prefix: (purpose: Purpose) => string;
	encodingFormat?: "float";
	truncate: boolean;
	sendDimensions: boolean;
	sendAuth: boolean;
	strictDimensions: boolean;
	url: (endpoint: string) => string;
	parse: (payload: unknown) => number[] | undefined;
}

function trimSlash(url: string): string {
	return url.replace(/\/$/u, "");
}

function asFiniteVector(vector: unknown): number[] | undefined {
	if (!Array.isArray(vector) || vector.length === 0) {
		return undefined;
	}
	const out: number[] = [];
	for (const n of vector) {
		if (typeof n !== "number" || !Number.isFinite(n)) {
			return undefined;
		}
		out.push(n);
	}
	return out;
}

function requirePositiveInt(value: number, label: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new MnemonEmbeddingError(`${label} must be a positive integer`);
	}
	return value;
}

function vectorField(payload: unknown, key: string): unknown {
	if (typeof payload !== "object" || payload === null || !(key in payload)) {
		return undefined;
	}
	return (payload as Record<string, unknown>)[key];
}

function openaiVector(payload: unknown): number[] | undefined {
	const first = vectorField(payload, "data");
	if (!Array.isArray(first)) {
		return undefined;
	}
	return asFiniteVector(
		(first as { embedding?: unknown }[])[0]?.embedding,
	);
}

function ollamaVector(payload: unknown): number[] | undefined {
	const first = vectorField(payload, "embeddings");
	if (!Array.isArray(first)) {
		return undefined;
	}
	return asFiniteVector(first[0]);
}

const PROTOCOL: Record<EmbeddingProtocol, ProtocolSpec> = {
	llamacpp: {
		label: "llama.cpp",
		defaultEndpoint: "http://127.0.0.1:8080",
		defaultDimensions: NOMIC_EMBED_TEXT_DIMENSIONS,
		prefix: (purpose) =>
			purpose === "query" ? "search_query: " : "search_document: ",
		encodingFormat: "float",
		truncate: true,
		sendDimensions: true,
		sendAuth: true,
		strictDimensions: false,
		url: (endpoint) => `${endpoint}/v1/embeddings`,
		parse: openaiVector,
	},
	openai: {
		label: "openai",
		defaultEndpoint: "https://api.openai.com",
		defaultDimensions: 1536,
		prefix: () => "",
		truncate: false,
		sendDimensions: true,
		sendAuth: true,
		strictDimensions: true,
		url: (endpoint) =>
			endpoint.endsWith("/v1")
				? `${endpoint}/embeddings`
				: `${endpoint}/v1/embeddings`,
		parse: openaiVector,
	},
	ollama: {
		label: "ollama",
		defaultEndpoint: "http://127.0.0.1:11434",
		defaultDimensions: NOMIC_EMBED_TEXT_DIMENSIONS,
		prefix: () => "",
		truncate: false,
		sendDimensions: false,
		sendAuth: false,
		strictDimensions: true,
		url: (endpoint) => `${endpoint}/api/embed`,
		parse: ollamaVector,
	},
};

function present(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveDimensions(
	explicit: number | undefined,
	protocol: EmbeddingProtocol,
): number {
	if (explicit !== undefined) {
		return requirePositiveInt(explicit, "dimensions");
	}
	const raw = present(process.env.MNEMON_EMBED_DIMENSIONS);
	if (raw) {
		return requirePositiveInt(Number(raw), "MNEMON_EMBED_DIMENSIONS");
	}
	return PROTOCOL[protocol].defaultDimensions;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
	readonly model: string;
	readonly dimensions: number;
	readonly protocol: EmbeddingProtocol;
	private readonly endpoint: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;

	constructor(options: HttpEmbeddingProviderOptions = {}) {
		this.protocol = options.protocol ?? "llamacpp";
		const spec = PROTOCOL[this.protocol];
		this.endpoint = trimSlash(
			present(options.endpoint) ??
				present(process.env.MNEMON_EMBED_ENDPOINT) ??
				spec.defaultEndpoint,
		);
		this.model =
			present(options.model) ??
			present(process.env.MNEMON_EMBED_MODEL) ??
			"nomic-embed-text";
		this.dimensions = resolveDimensions(options.dimensions, this.protocol);
		this.apiKey =
			present(options.apiKey) ?? present(process.env.MNEMON_EMBED_API_KEY);
		const timeoutRaw = present(process.env.MNEMON_EMBED_TIMEOUT_MS);
		this.timeoutMs = requirePositiveInt(
			options.timeoutMs ?? (timeoutRaw ? Number(timeoutRaw) : 10_000),
			"timeoutMs",
		);
	}

	async embed(text: string, purpose: Purpose): Promise<readonly number[]> {
		const spec = PROTOCOL[this.protocol];
		const body: Record<string, unknown> = {
			input: spec.prefix(purpose) + text,
			model: this.model,
		};
		if (spec.sendDimensions) {
			body.dimensions = this.dimensions;
		}
		if (spec.encodingFormat) {
			body.encoding_format = spec.encodingFormat;
		}

		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (spec.sendAuth && this.apiKey) {
			headers.authorization = `Bearer ${this.apiKey}`;
		}

		let response: Response;
		try {
			response = await fetch(spec.url(this.endpoint), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new MnemonEmbeddingError(`${spec.label} embedding request failed`, {
				cause: error,
			});
		}
		if (!response.ok) {
			throw new MnemonEmbeddingError(
				`${spec.label} embedding failed: ${response.status}`,
			);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new MnemonEmbeddingError(`${spec.label} returned invalid JSON`, {
				cause: error,
			});
		}
		const vector = spec.parse(payload);
		if (!vector) {
			throw new MnemonEmbeddingError(`${spec.label} returned no embedding`);
		}
		if (spec.truncate && vector.length > this.dimensions) {
			return vector.slice(0, this.dimensions);
		}
		if (
			(spec.truncate || spec.strictDimensions) &&
			vector.length !== this.dimensions
		) {
			throw new MnemonEmbeddingError(
				`embedding dimension mismatch: requested ${this.dimensions}, received ${vector.length}`,
			);
		}
		return vector;
	}
}

export class LlamaCppEmbeddingProvider extends HttpEmbeddingProvider {
	constructor(options: Omit<HttpEmbeddingProviderOptions, "protocol"> = {}) {
		super({ ...options, protocol: "llamacpp" });
	}
}

export class OpenAIEmbeddingProvider extends HttpEmbeddingProvider {
	constructor(options: Omit<HttpEmbeddingProviderOptions, "protocol"> = {}) {
		super({ ...options, protocol: "openai" });
	}
}

export class OllamaEmbeddingProvider extends HttpEmbeddingProvider {
	constructor(options: Omit<HttpEmbeddingProviderOptions, "protocol"> = {}) {
		super({ ...options, protocol: "ollama" });
	}
}
