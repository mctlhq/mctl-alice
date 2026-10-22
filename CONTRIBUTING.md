# Contributing

Thanks for your interest in mctl-alice.

- **Security issues:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bugs and ideas:** open an issue with the template that fits.
- **Pull requests:** branch from `main`, keep one change per PR, and use
  [conventional commit](https://www.conventionalcommits.org/) messages
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Every PR runs CI and an
  automated review, and is merged with a merge commit.

## Local development

Requires Node.js 22.

```sh
npm ci
npm run build
npm test
```

Tests that need PostgreSQL run against a disposable database named by
`TEST_POSTGRES_URL` and are skipped when it is unset. Never point it at a
database you care about. Copy `.env.example` to `.env` for a local single-user run.

Code, comments and documentation are in English. User-facing site text is in
Russian and English (`public/assets/site.js`); add every new string to both.
