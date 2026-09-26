import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
		// Integration suites share one database; keep files sequential.
		fileParallelism: false,
		coverage: {
			include: ["packages/*/src/**"],
			reporter: ["text", "html"],
		},
	},
});
