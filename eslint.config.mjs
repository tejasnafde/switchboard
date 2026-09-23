// Switchboard ESLint config — deslop-focused.
//
// Goal: catch *mechanical* AI-generated noise on staged-files-only at commit
// time. Not a general code-style enforcer. Only rules that earn their seat
// because they correlate with low-quality agent output (excess `as any`,
// useless try/catch, etc.) live here.
//
// Run via:
//   npm run lint:deslop          all of src/ (surfaces deslop-debt)
//   npm run lint:deslop:staged   only staged files (used by pre-commit)
//
// To skip a specific occurrence with a reason:
//   // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape unknown at this boundary
//   const data = raw as any
//
// Bare disables without a `-- reason` comment are themselves slop; we may
// turn that on as an error in a follow-up.

import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      'build/**',
      'videos/**',
      'tests/**',          // tests legitimately use `as any` for fixtures
      '**/*.config.*',
      'scripts/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      // Registered so existing `// eslint-disable-next-line react-hooks/...`
      // directives in the codebase resolve. Rules are NOT enabled here —
      // we may turn them on as warnings in a follow-up.
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
      },
    },
    rules: {
      // The four rules that actually catch deslop. Keep this list tight —
      // every additional rule is a tax on every commit and an excuse to
      // disable lint-staged.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-useless-catch': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'no-useless-rename': 'error',
      // No silent catches (AGENTS.md "Logging conventions"): every catch that
      // doesn't re-throw must log through the module's scoped logger. A
      // comment-only body still has body.length 0 - that's the point,
      // `catch { /* ignore */ }` is exactly the pattern this bans. For the
      // handful of sites where logging is impossible or harmful (the
      // logger's own write path, pointer-capture release, etc.), use:
      //   // eslint-disable-next-line no-restricted-syntax -- <reason>
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause > BlockStatement[body.length=0]',
          message:
            'Empty catch block - log the error with the scoped logger (see AGENTS.md Logging conventions), or add a disable comment explaining why logging is impossible or harmful here.',
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
          message:
            'Empty .catch(() => {}) handler - log the rejection with the scoped logger (see AGENTS.md Logging conventions), or add a disable comment explaining why logging is impossible or harmful here.',
        },
      ],
    },
  },
)
