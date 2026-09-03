import obsidian from 'eslint-plugin-obsidianmd';
import unusedImports from 'eslint-plugin-unused-imports';
import prettier from 'eslint-config-prettier';

export default [
    {
        ignores: [
            '**/node_modules/**',
            'main.js',
            'tests/**',
            '**/*.test.ts',
            '**/*.spec.ts',
            'docs/**',
            'coverage/**',
            'dist/**',
            'build/**',
        ],
    },
    ...obsidian.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { 'unused-imports': unusedImports },
        rules: {
            'unused-imports/no-unused-imports': 'error',
            'unused-imports/no-unused-vars': [
                'error',
                {
                    vars: 'all',
                    varsIgnorePattern: '^_',
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/no-empty-function': 'warn',
            '@typescript-eslint/no-var-requires': 'warn',
            '@typescript-eslint/no-inferrable-types': 'warn',
            'no-console': [
                'error',
                {
                    allow: ['warn', 'error', 'debug'],
                },
            ],
            'prefer-const': 'error',
            'no-var': 'error',
            'no-case-declarations': 'off',
            'obsidianmd/ui/sentence-case': [
                'warn',
                {
                    enforceCamelCaseLower: true,
                    brands: ['Deepgram', 'OpenAI', 'Whisper', 'Obsidian', 'JavaScript', 'Python'],
                    allowAutoFix: true,
                    ignoreWords: ['MiB', 'cursor', 's'],
                    ignoreRegex: ['^https?://'],
                },
            ],
            '@typescript-eslint/no-empty-object-type': 'error',
            '@typescript-eslint/no-wrapper-object-types': 'error',
        },
    },
    prettier,
];
