import { defineConfig } from "vitest/config";

// Calls paid model APIs; run explicitly with `npm run test:e2e`.
try {
	process.loadEnvFile();
} catch (error) {
	// `.env` is optional; a malformed one is not.
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.e2e.test.ts"],
		fileParallelism: false,
	},
});
