/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Enforce conventional commit types used in this project.
    // commit-and-tag-version maps these to semver bumps:
    //   feat  → minor,  fix/perf → patch,  BREAKING CHANGE footer → major
    'type-enum': [2, 'always', [
      'feat',     // new feature (minor bump)
      'fix',      // bug fix (patch bump)
      'perf',     // performance improvement (patch bump)
      'refactor', // neither feat nor fix (no bump)
      'docs',     // documentation only (no bump)
      'chore',    // build/tooling/deps (no bump)
      'ci',       // CI/CD changes (no bump)
      'test',     // tests only (no bump)
      'style',    // formatting (no bump)
      'revert',   // revert a commit (patch bump)
    ]],
    'subject-case': [2, 'always', 'lower-case'],
    'header-max-length': [2, 'always', 100],
  },
}
