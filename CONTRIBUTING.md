# Contributing

- Run `npm test` before opening a pull request. Rampart has no npm dependencies; the tests use the built-in `node:test` runner. The scripts need Node 20 or newer; running `npm test` on Windows needs Node 21 or newer.
- Run `npm run validate` when you touch `.claude-plugin/`, the skill or the agents. It runs `claude plugin validate --strict` on `.claude-plugin/plugin.json` and on `.claude-plugin/marketplace.json`, each by its path.
- Write commit messages as conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- Packs are added by pull request. Contributor guidance for packs is a placeholder until Plan 2.
