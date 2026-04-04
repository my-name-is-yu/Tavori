import boundaries from "eslint-plugin-boundaries";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// Alias deprecated rule name for backward compatibility with existing disable comments
const tsPluginWithAliases = {
  ...tsPlugin,
  rules: {
    ...tsPlugin.rules,
    // Renamed in @typescript-eslint v6: no-throw-literal -> only-throw-error
    "no-throw-literal": tsPlugin.rules["only-throw-error"],
  },
};

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    linterOptions: {
      // Suppress warnings for disable directives that reference registered-but-not-enabled rules
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      boundaries,
      // Load @typescript-eslint plugin (with rule aliases) so eslint-disable comments are recognized
      "@typescript-eslint": tsPluginWithAliases,
    },
    settings: {
      "boundaries/elements": [
        { type: "base", pattern: "src/base/**" },
        { type: "platform", pattern: "src/platform/**" },
        { type: "orchestrator", pattern: "src/orchestrator/**" },
        { type: "interface", pattern: "src/interface/**" },
        {
          type: "shared",
          pattern: [
            "src/adapters/**",
            "src/prompt/**",
            "src/reflection/**",
            "src/reporting/**",
            "src/runtime/**",
          ],
        },
      ],
    },
    rules: {
      // Enforce layer hierarchy: no upward imports
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          rules: [
            // base: can only import from base
            { from: { type: "base" }, allow: { to: { type: "base" } } },
            // platform: can import base + shared
            { from: { type: "platform" }, allow: { to: { type: ["base", "shared"] } } },
            // orchestrator: can import base + platform + shared
            { from: { type: "orchestrator" }, allow: { to: { type: ["base", "platform", "shared"] } } },
            // interface: can import base + platform + orchestrator + shared
            { from: { type: "interface" }, allow: { to: { type: ["base", "platform", "orchestrator", "shared"] } } },
            // shared (cross-cutting): can import base + platform + orchestrator (NOT interface)
            { from: { type: "shared" }, allow: { to: { type: ["base", "platform", "orchestrator", "shared"] } } },
          ],
        },
      ],
      // Entry-point enforcement is off — we only care about layer boundaries
      "boundaries/entry-point": "off",
    },
  },
];

export default config;
