import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Ignore build output, generated files and vendored code.
  {
    ignores: [
      '**/node_modules/**',
      '**/.output/**',
      '**/dist/**',
      '**/.wxt/**',
      '.codegraph/**',
      '**/*.min.js',
      // Vendored laya-ts runtime (upstream: NandhaKishorM/laya, Apache-2.0).
      // Kept as close to upstream as possible; our extension glue
      // (runtime.ts, laya-session.ts) is explicitly un-ignored below.
      'packages/extension/lib/ai/*.ts',
      '!packages/extension/lib/ai/runtime.ts',
      '!packages/extension/lib/ai/laya-session.ts',
    ],
  },

  // Base JS + TS recommended rules for all source files.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React (extension package) — browser + JSX.
  {
    files: ['packages/extension/**/*.{ts,tsx,js,jsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // React 19 + TS: no need for prop-types / React in scope.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      // react-hooks v7 opinionated best-practices — warn for existing code,
      // so lint doesn't hard-fail; tighten to error once the codebase is clean.
      'react-hooks/set-state-in-effect': 'warn',
      'preserve-caught-error': 'warn',
    },
  },

  // MCP package — Node environment.
  {
    files: ['packages/mcp/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Skill helper scripts — standalone Node scripts run outside
  // the packages, so they get Node globals (process/console/fetch/URL) too.
  // (.claude/skills/* 是指向 packages/skills/* 的符号链接，ESLint 按真实路径匹配。)
  {
    files: ['.claude/**/*.{mjs,cjs,js}', 'packages/skills/**/*.{mjs,cjs,js}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Shared TS relaxations across the monorepo.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Existing-code cleanliness rules — warn, don't hard-fail.
      'no-useless-assignment': 'warn',
    },
  },

  // Extension-side laya glue (NOT the vendored lib/ai runtime — that is
  // ignored above): runtime.ts, laya-session.ts follow repo rules fully.
  prettier,
);