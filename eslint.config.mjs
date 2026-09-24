// Flat config. The app is plain browser scripts loaded with <script> tags —
// no bundler, no modules — so `sourceType: 'script'` and browser globals.
import globals from 'globals';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

export default [
  {
    ignores: ['node_modules/**', 'supabase/**', 'vendor/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Loaded from vendor/ by a <script> tag ahead of app.js.
        supabase: 'readonly',
      },
    },
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      // The rules that earn their keep on this codebase. `method` and
      // `property` are what caught the roster XSS: they flag innerHTML and
      // insertAdjacentHTML written from anything that isn't a literal.
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',

      // A caught error bound and then discarded is how the Supabase fetch
      // failure went undiagnosable in the field.
      'no-unused-vars': ['error', { caughtErrors: 'all', argsIgnorePattern: '^_' }],

      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // The GitHub Pages deep-link shim in 404.html / index.html is inline
    // ES5 and deliberately so — it must run before anything else.
    files: ['eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
];
