import { afterEach, describe, expect, it } from "vitest";
import { MnemonEmbeddingError } from "../../src/errors.js";
import {
	LlamaCppEmbeddingProvider,
	OllamaEmbeddingProvider,
	OpenAIEmbeddingProvider,
} from "../../src/http-embedding-provider.js";

const originalFetch = globalThis.fetch;
const originalEmbedKey = process.env.MNEMON_EMBED_API_KEY;
const originalEmbedDimensions = process.env.MNEMON_EMBED_DIMENSIONS;
const originalEmbedEndpoint = process.env.MNEMON_EMBED_ENDPOINT;
const originalEmbedModel = process.env.MNEMON_EMBED_MODEL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEmbedKey === undefined) delete process.env.MNEMON_EMBED_API_KEY;
	else process.env.MNEMON_EMBED_API_KEY = originalEmbedKey;
	if (originalEmbedDimensions === undefined) {
		delete process.env.MNEMON_EMBED_DIMENSIONS;
	} else {
		process.env.MNEMON_EMBED_DIMENSIONS = originalEmbedDimensions;
	}
	if (originalEmbedEndpoint === undefined) {
		delete process.env.MNEMON_EMBED_ENDPOINT;
	} else {
		process.env.MNEMON_EMBED_ENDPOINT = originalEmbedEndpoint;
	}
	if (originalEmbedModel === undefined) {
		delete process.env.MNEMON_EMBED_MODEL;
	} else {
		process.env.MNEMON_EMBED_MODEL = originalEmbedModel;
	}
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

function stubFetch(
	impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
	globalThis.fetch = impl;
}

describe("LlamaCppEmbeddingProvider", () => {
	it("prefixes nomic text, sends dimensions, and uses encoding_format float", async () => {
		const calls: { url: string; headers: unknown; body: unknown }[] = [];
		stubFetch(async (url, init) => {
			calls.push({
				url: String(url),
				headers: init?.headers,
				body: JSON.parse(String(init?.body)),
			});
			return jsonResponse({
				data: [{ embedding: Array.from({ length: 768 }, () => 0.1) }],
			});
		});
		const provider = new LlamaCppEmbeddingProvider({
			endpoint: "http://127.0.0.1:8080",
			model: "nomic-embed-text",
			dimensions: 768,
		});
		await provider.embed("hello", "document");
		await provider.embed("hello", "query");
		expect(calls.map((c) => c.url)).toEqual([
			"http://127.0.0.1:8080/v1/embeddings",
			"http://127.0.0.1:8080/v1/embeddings",
		]);
		expect(calls.map((c) => c.body)).toEqual([
			{
				input: "search_document: hello",
				model: "nomic-embed-text",
				dimensions: 768,
				encoding_format: "float",
			},
			{
				input: "search_query: hello",
				model: "nomic-embed-text",
				dimensions: 768,
				encoding_format: "float",
			},
		]);
		expect(provider.dimensions).toBe(768);
	});

	it("sends a bearer token and truncates Matryoshka extras", async () => {
		process.env.MNEMON_EMBED_API_KEY = "secret-key";
		stubFetch(async (_url, init) => {
			expect(init?.headers).toMatchObject({
				authorization: "Bearer secret-key",
			});
			return jsonResponse({ data: [{ embedding: [1, 2, 3, 4] }] });
		});
		const provider = new LlamaCppEmbeddingProvider({
			endpoint: "http://127.0.0.1:8080",
			dimensions: 2,
		});
		await expect(provider.embed("hello", "query")).resolves.toEqual([1, 2]);
	});

	it("rejects non-positive or non-integer explicit dimensions", () => {
		expect(() => new LlamaCppEmbeddingProvider({ dimensions: 0 })).toThrow(
			MnemonEmbeddingError,
		);
		expect(() => new LlamaCppEmbeddingProvider({ dimensions: -3 })).toThrow(
			MnemonEmbeddingError,
		);
		expect(() => new LlamaCppEmbeddingProvider({ dimensions: 1.5 })).toThrow(
			MnemonEmbeddingError,
		);
	});

	it("rejects non-finite embedding elements and invalid JSON", async () => {
		stubFetch(async () =>
			jsonResponse({
				data: [{ embedding: [0.1, null, 0.2] }],
			}),
		);
		const provider = new LlamaCppEmbeddingProvider({ dimensions: 3 });
		await expect(provider.embed("hello", "query")).rejects.toBeInstanceOf(
			MnemonEmbeddingError,
		);
		stubFetch(async () => new Response("not-json", { status: 200 }));
		await expect(provider.embed("hello", "query")).rejects.toBeInstanceOf(
			MnemonEmbeddingError,
		);
	});

	it("throws when llama.cpp is unavailable", async () => {
		stubFetch(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		const provider = new LlamaCppEmbeddingProvider();
		await expect(provider.embed("hello", "query")).rejects.toBeInstanceOf(
			MnemonEmbeddingError,
		);
	});

	it("treats empty endpoint and model as absent", async () => {
		delete process.env.MNEMON_EMBED_ENDPOINT;
		delete process.env.MNEMON_EMBED_MODEL;
		const calls: { url: string; body: unknown }[] = [];
		stubFetch(async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return jsonResponse({
				data: [{ embedding: Array.from({ length: 768 }, () => 0.1) }],
			});
		});
		const provider = new LlamaCppEmbeddingProvider({
			endpoint: "  ",
			model: "",
			dimensions: 768,
		});
		await provider.embed("hello", "query");
		expect(calls[0]?.url).toBe("http://127.0.0.1:8080/v1/embeddings");
		expect(calls[0]?.body).toMatchObject({ model: "nomic-embed-text" });
	});
});

describe("OpenAIEmbeddingProvider", () => {
	it("defaults to the OpenAI embeddings host", async () => {
		const calls: string[] = [];
		stubFetch(async (url) => {
			calls.push(String(url));
			return jsonResponse({
				data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }],
			});
		});
		delete process.env.MNEMON_EMBED_ENDPOINT;
		const provider = new OpenAIEmbeddingProvider({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
			dimensions: 1536,
		});
		await provider.embed("hello", "query");
		expect(calls[0]).toBe("https://api.openai.com/v1/embeddings");
	});

	it("posts raw text to /v1/embeddings without nomic prefixes", async () => {
		const calls: { url: string; body: unknown }[] = [];
		stubFetch(async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
		});
		const provider = new OpenAIEmbeddingProvider({
			endpoint: "http://127.0.0.1:4000/v1",
			model: "text-embedding-3-small",
			dimensions: 2,
		});
		await provider.embed("hello", "query");
		expect(calls).toEqual([
			{
				url: "http://127.0.0.1:4000/v1/embeddings",
				body: {
					input: "hello",
					model: "text-embedding-3-small",
					dimensions: 2,
				},
			},
		]);
	});

	it("rejects a dimension mismatch when strictDimensions is on", async () => {
		stubFetch(async () =>
			jsonResponse({
				data: [{ embedding: [0.1, 0.2, 0.3] }],
			}),
		);
		const provider = new OpenAIEmbeddingProvider({
			endpoint: "http://127.0.0.1:4000/v1",
			dimensions: 2,
		});
		await expect(provider.embed("hello", "query")).rejects.toBeInstanceOf(
			MnemonEmbeddingError,
		);
	});
});

describe("OllamaEmbeddingProvider", () => {
	it("posts raw text to /api/embed without nomic prefixes", async () => {
		const calls: { url: string; body: unknown }[] = [];
		stubFetch(async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return jsonResponse({
				embeddings: [Array.from({ length: 768 }, () => 0.1)],
			});
		});
		const provider = new OllamaEmbeddingProvider({
			endpoint: "http://127.0.0.1:11434",
			model: "nomic-embed-text",
			dimensions: 768,
		});
		await provider.embed("hello", "query");
		expect(calls).toEqual([
			{
				url: "http://127.0.0.1:11434/api/embed",
				body: { model: "nomic-embed-text", input: "hello" },
			},
		]);
	});

	it("does not send dimensions even when MNEMON_EMBED_DIMENSIONS is set", async () => {
		process.env.MNEMON_EMBED_DIMENSIONS = "256";
		const calls: { url: string; body: unknown }[] = [];
		stubFetch(async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return jsonResponse({
				embeddings: [Array.from({ length: 768 }, () => 0.1)],
			});
		});
		const provider = new OllamaEmbeddingProvider({
			endpoint: "http://127.0.0.1:11434",
			model: "nomic-embed-text",
			dimensions: 768,
		});
		await provider.embed("hello", "query");
		expect(calls).toEqual([
			{
				url: "http://127.0.0.1:11434/api/embed",
				body: { model: "nomic-embed-text", input: "hello" },
			},
		]);
	});
});
