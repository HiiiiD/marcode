import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts", "**/*.tsx"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}, {
    // Vendored shadcn/ui primitives (src/webview/components/ui) are copied
    // verbatim from the shadcn registry and kept diffable against upstream.
    // They are written without semicolons (Prettier's semi:false style),
    // so first-party formatting rules don't apply to this directory.
    files: ["src/webview/components/ui/**/*.tsx"],
    rules: {
        semi: "off",
    },
}];