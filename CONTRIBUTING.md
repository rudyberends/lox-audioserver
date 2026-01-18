# Contributing

Thanks for contributing to lox-audioserver! Below are short guidelines to keep contributions consistent with automated releases and commit linting.

## Commit messages
We use Conventional Commits. Some examples:

- `feat: add blablabla`
- `fix(parser): prevent crash on missing metadata`
- `chore: update dependencies`
- `docs: update README`
- `refactor!: change API contract` (the `!` marks a breaking change)

## Branch strategy
- `beta`: for unstable or testing releases. Open PRs to `beta` to test features in a pre-release.
- `main`: stable releases. Only merge into `main` when code is tested and approved.

## Releases
- `semantic-release` runs automatically for pushes to `beta` and `main`.
- `beta` produces prereleases like `2.2.0-beta.1`.
- `main` produces normal semver releases like `2.2.0`.

## Pull Request flow
1. Create a feature branch from `main`.
2. Open a PR and ask for reviews.
3. Ensure all CI checks are green (lint, tests, commitlint).