import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'ios/**',
      'mcp/**',
      'public/sw.js',
      'scripts/appstore-next-build-number.mjs',
      'scripts/check-layout.mjs',
      'scripts/check-workout-edit.mjs',
      'scripts/ios-project-check.mjs',
      'scripts/preview-funnel.mjs',
      'scripts/preview-loop.mjs',
      'scripts/gen-icons.py',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'scripts/**/*.{js,mjs}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
