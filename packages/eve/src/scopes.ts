import type { MemoryScopeContext } from "eve/memory";

export interface TenantScopeOptions {
	/** Auth attribute that carries the tenant id. Default `"tenantId"`. */
	tenantAttribute?: string;
}

export interface TenantScopes {
	/** `[tenantId]` for organization-shared memory, or `null` (slot disabled). */
	byTenant: (context: MemoryScopeContext) => [string] | null;
	/**
	 * `[tenantId, userId]` for private per-user memory, or `null`. `userId` is
	 * composed like Eve's `byPrincipal`, so the same principal id from two
	 * authenticators or issuers stays apart.
	 */
	byTenantPrincipal: (context: MemoryScopeContext) => [string, string] | null;
}

/**
 * Scope resolvers that derive identity only from the authenticated session.
 * They fail closed: anything but an authenticated `user` principal with a
 * single non-empty tenant attribute disables the slot. There is no fallback
 * to a shared, default, or anonymous scope.
 */
export function tenantScopes(options: TenantScopeOptions = {}): TenantScopes {
	const attribute = options.tenantAttribute ?? "tenantId";
	const identity = (context: MemoryScopeContext) => {
		const principal = context.session.auth.current;
		if (
			principal?.principalType !== "user" ||
			!isIdentifier(principal.principalId)
		) {
			return null;
		}
		// Arrays mean multi-tenant membership; picking one would be a guess.
		const tenantId = principal.attributes[attribute];
		if (!isIdentifier(tenantId)) {
			return null;
		}
		const userId = JSON.stringify([
			principal.principalType,
			principal.authenticator,
			principal.issuer ?? null,
			principal.principalId,
		]);
		return isIdentifier(userId) ? { tenantId, userId } : null;
	};
	return {
		byTenant(context) {
			const id = identity(context);
			return id ? [id.tenantId] : null;
		},
		byTenantPrincipal(context) {
			const id = identity(context);
			return id ? [id.tenantId, id.userId] : null;
		},
	};
}

export const { byTenant, byTenantPrincipal } = tenantScopes();

export function isIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 1024 &&
		value.trim() === value
	);
}
