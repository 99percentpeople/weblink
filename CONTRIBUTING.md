# Contributing

Pull requests should target the `public` branch and keep existing
protocol and user-facing behavior compatible unless a breaking
change has been discussed first.

## Required checks

CI runs for every pull request. A pull request must pass the
`CI / Checks` job before it can be merged. The job uses Bun 1.3.8
and runs:

```bash
bun install --frozen-lockfile
bun run lint
bun test
bunx vitest run
bun run build
```

Run the same commands locally before opening or updating a pull
request. Do not add deployment credentials to pull request
workflows; CI must remain safe for contributions from forks.

## Code changes

- Keep TypeScript strict and format changed files with Prettier.
- Add focused tests for new behavior and bug fixes.
- Keep WebRTC details inside `src/libs/core` and app orchestration
  inside `src/libs/services`.
- Version protocol changes and preserve backward compatibility where
  possible.
