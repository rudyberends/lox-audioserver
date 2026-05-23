# Contributing

Thanks for contributing to lox-audioserver! Below are short guidelines to keep contributions consistent with our branch flow, Docker builds and commit linting.

## Commit messages
We use Conventional Commits (enforced by commitlint on every PR). Some examples:

- `feat: add blablabla`
- `fix(parser): prevent crash on missing metadata`
- `chore: update dependencies`
- `docs: update README`
- `refactor!: change API contract` (the `!` marks a breaking change)

## Branch strategy
- `dev`: integration branch. All PRs target `dev`. Every push to `dev` builds and publishes the `ghcr.io/.../lox-audioserver:dev` and `:dev-latest` Docker images.
- `beta`: prerelease channel. Promoted from `dev` when a prerelease is cut.
- `main`: stable channel. Promoted from `beta` (or `dev`) when a stable release is cut.

## Pull Request flow
1. Create a feature branch from `dev`.
2. Open a PR targeting `dev` and ask for reviews.
3. Ensure all CI checks are green (lint, tests, commitlint).
4. Once merged into `dev`, the change is available via the `:dev` Docker tag.

## Releases
Releases are cut manually from a GitHub Release. A prerelease publishes Docker tags `:<version>`, `:beta` and `:beta-latest`; a stable release publishes `:<version>` and `:latest`.
