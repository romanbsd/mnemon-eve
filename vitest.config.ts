import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["**/*.e2e.test.ts", "**/node_modules/**"],
		// Integration suites share one database; keep files sequential.
		fileParallelism: false,
	},
});
