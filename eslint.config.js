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

  // Skill helper scripts (.claude/skills) — standalone Node scripts run outside
  // the packages, so they get Node globals (process/console/fetch/URL) too.
  {
    files: ['.claude/**/*.{mjs,cjs,js}'],
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
  prettier,
);