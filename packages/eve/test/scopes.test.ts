import type { MemoryScopeContext } from "eve/memory";
import { describe, expect, it } from "vitest";

import { byTenant, byTenantPrincipal, resolveScope, tenantScopes } from "../src/index.js";

function ctx(current: Record<string, unknown> | null): MemoryScopeContext {
	return {
		abortSignal: new AbortController().signal,
		session: { id: "s", auth: { current, initiator: null } },
		channel: {},
	} as unknown as MemoryScopeContext;
}

const user = (attributes: Record<string, unknown>, extra = {}) =>
	ctx({
		principalType: "user",
		principalId: "user-1",
		authenticator: "test",
		attributes,
		...extra,
	});

describe("scope resolvers", () => {
	it("derive tenant and tenant+user scopes from session auth", () => {
		expect(byTenant(user({ tenantId: "t1" }))).toEqual(["t1"]);
		expect(byTenantPrincipal(user({ tenantId: "t1" }))).toEqual(["t1", "user-1"]);
	});

	it("fail closed without an authenticated user and a single tenant", () => {
		const denied = [
			ctx(null),
			user({}),
			user({ tenantId: "" }),
			user({ tenantId: " t1" }),
			user({ tenantId: ["t1", "t2"] }),
			user({ tenantId: ["t1"] }),
			user({ tenantId: "t1" }, { principalType: "anonymous" }),
			user({ tenantId: "t1" }, { principalType: "runtime" }),
			user({ tenantId: "t1" }, { principalType: "service" }),
			user({ tenantId: "t1" }, { principalId: "" }),
		];
		for (const c of denied) {
			expect(byTenant(c)).toBeNull();
			expect(byTenantPrincipal(c)).toBeNull();
		}
	});

	it("reads a configurable tenant attribute", () => {
		const { byTenant: byOrg } = tenantScopes({ tenantAttribute: "orgId" });
		expect(byOrg(user({ orgId: "o1" }))).toEqual(["o1"]);
		expect(byOrg(user({ tenantId: "t1" }))).toBeNull();
	});
});

describe("resolveScope", () => {
	const scope = (value: string | string[]) => ({
		slot: "s",
		scope: { key: "k", namespace: "n", value },
	});

	it("maps the locked scope to authorization", () => {
		expect(resolveScope(scope(["t1"]), "organization").auth).toEqual({
			tenantId: "t1",
			userId: null,
			namespace: "k",
		});
		expect(resolveScope(scope(["t1", "u1"]), "personal").auth.userId).toBe("u1");
	});

	it("rejects scopes that do not match the audience", () => {
		expect(() => resolveScope(scope("t1"), "organization")).toThrow();
		expect(() => resolveScope(scope(["t1", "u1"]), "organization")).toThrow();
		expect(() => resolveScope(scope(["t1"]), "personal")).toThrow();
		expect(() => resolveScope(scope(["", "u1"]), "personal")).toThrow();
	});
});
