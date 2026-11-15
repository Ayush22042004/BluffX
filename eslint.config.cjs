const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.data/**",
      "**/test-results/**",
    ],
  },
  {
    files: ["server/src/**/*.js", "server/scripts/**/*.js"],
    ...js.configs.recommended,
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["client/src/**/*.{js,jsx}", "client/vite.config.js"],
    languageOptions: {
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": "off",
    },
  },
];
