import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
	{ ignores: ["**/dist/", "**/node_modules/", "**/coverage/", "**/.vitest/"] },
	js.configs.recommended,
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			"no-empty": ["error", { allowEmptyCatch: true }],
			// Conflicts with no-non-null-assertion; prefer explicit `as` casts.
			"@typescript-eslint/non-nullable-type-assertion-style": "off",
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
			"@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
		},
	},
	{
		// Fakes and stubs implement async interfaces without awaiting.
		files: ["packages/*/test/**/*.ts"],
		rules: {
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			// Tests inspect untyped JSON bodies and pass methods to helpers.
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/unbound-method": "off",
		},
	},
	{
		files: ["**/*.js", "vitest*.config.ts"],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
