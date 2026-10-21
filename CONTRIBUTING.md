# Feedback and contributions

MyAgentRoam is maintainer-led. The maintainer owns product direction, implementation,
and integration decisions. **Bug reports, reproducible examples, and feature proposals
are the preferred ways to help.** Use the issue forms to describe a problem and the
outcome you need before investing in a substantial patch.

## Why this model in an AI-assisted project?

AI-assisted development makes producing candidate code easier; deciding what should
exist, keeping the architecture coherent, verifying behavior, and maintaining it
remain the maintainer's responsibility. This project therefore prioritizes clear
problem reports, use cases, and acceptance criteria over the volume of submitted code.
The maintainer may use the project's own AI-assisted workflow to implement and verify
an idea instead of integrating an external patch as written. This is a choice about
consistency and long-term ownership, not a judgment of a contributor's effort or ability.

## How pull requests are handled

Pull requests may be reviewed as references, but submitting one does not imply that
it will be reviewed, accepted, or merged. The maintainer may adopt only the idea,
reimplement it independently, or incorporate selected changes rather than merge the
branch. Adopted suggestions or work may be acknowledged with a mention or credit;
this does not promise a merge or ongoing collaboration. Reused code remains subject
to its applicable license and attribution requirements; a thank-you is not a substitute.

If you still submit a patch, keep it focused and provide relevant verification.
For suspected vulnerabilities, use [private reporting](SECURITY.md), not a public issue.

## Local setup

This repository is an independent pnpm Workspace with its own lockfile. Use the
pnpm version declared in `package.json` and Node.js `>=24.12` for full-product
development (the standalone Node executor has its own minimum).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:web
```

The Web development app defaults to port `5093`; it needs a configured Server for
authenticated use. These commands do not provision MySQL, real host UUID access,
or TLS. Follow the [deployment guide](docs/help/en-US/getting-started/server-installation.md)
for a complete installation.

## Change and test scope

- Keep Agent runtime changes in `mar-agent/`; consumers should adapt its public
  interfaces rather than duplicate the kernel. See the [component overview](docs/help/en-US/concepts/architecture.md).
- Keep source and code comments in English. Preserve readable Unicode test inputs
  where the behavior requires them. Update both `zh-CN` and `en-US` UI messages and
  public help when changing user-visible behavior.
- Use `pnpm test:discover -- --query <keywords>` to locate source-declared tests,
  then confirm the selection with the owning runner before execution. Prefer
  focused checks over running the entire repository for every patch.
- Name test files after their domain and behavior, with unique suite/case titles
  describing conditions and observable outcomes. Do not allocate sequential test IDs.
  Optional English `@test-contract domain.behavior` and `@test-covers path/to/source`
  comments provide file-level associations when imports are insufficient.
- Test normal behavior, important boundaries, and failure paths. Use disposable
  resources, never a shared development or production database. Database-backed
  tests use the existing test wrappers, a unique `MAR_TEST_RUN_ID`, and a dedicated
  `MAR_TEST_DATABASE_ADMIN_URL`; never use production credentials.
- Format only changed files. Run `pnpm docs:validate` for public-help edits and
  `pnpm check:public-boundary` for public-boundary changes. Include actual commands,
  outcomes, and any unverified areas in the pull request.

Example focused checks (adjust the case to the change):

```sh
pnpm test:discover -- --query public-boundary
node --test test/unit/public-boundary.test.mjs
pnpm exec prettier --check CONTRIBUTING.md
```

Server, Web, EE, public cores, Agent, Node, and Protocol use the version recorded
in the product release manifest. Code Navigation, marctl, and Computer Use Runtime
retain independent revisions; package versions do not replace capability checks.

## Licensing

Read [LICENSING.md](LICENSING.md) before contributing. The repository is mixed-license,
not entirely Apache-2.0. Core contributions retain their applicable license;
read Section 8 of [the EE license](ee/LICENSE) before contributing to covered code.
Do not include secrets, customer data, proprietary source you cannot contribute,
or third-party material without the required rights and notices.
