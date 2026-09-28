# Contributing to Exulu

Thanks for wanting to contribute. This page explains the terms your contribution
is accepted under, and the practical steps.

## Before your pull request can be merged

**1. Agree to the Contributor License Agreement.**

Every contributor must agree to the [Contributor License Agreement](CLA.md)
before we can merge their work. You keep ownership of your contribution; the
agreement gives Qventu B.V. the rights it needs to distribute and license it,
including under the commercial terms that apply to parts of this project.

When you open a pull request, a bot will check whether you have already agreed.
If you have not, it will comment with a one-line instruction. Agreement is
recorded against your GitHub account and you only need to do it once.

**2. Sign off your commits.**

Add a `Signed-off-by` line to each commit, certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

This produces:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an address you can be reached at.

**3. Declare anything you did not write.**

If your contribution includes or is derived from code, model weights, datasets,
fonts, icons or other material you did not write yourself, say so in the pull
request description and name the licence. This matters more than it may seem:
we ship parts of this project commercially, and material with a copyleft,
non-commercial or unclear licence cannot be accepted. If you are unsure, ask in
the pull request rather than leaving it out.

## Why there is a CLA rather than just a DCO

Exulu is open-core. Most of the project is under the Elastic License 2.0
(see [`license.md`](license.md)), while certain enterprise functionality is
licensed commercially under the Exulu Enterprise License
(see [`ee/LICENSE.md`](ee/LICENSE.md)).

A DCO certifies that you have the right to submit your work under the project's
existing licence. That is not sufficient here, because we need the right to
license contributions under commercial terms too. The CLA grants that. We ask for
both: the CLA for the rights, the sign-off for the per-commit record.

Note that the Exulu Enterprise License defines enterprise material by
**licence-gating rather than by directory**, so a contribution anywhere in the
repository may end up in commercially licensed functionality.

## Practical steps

1. Open an issue first for anything substantial, so we can agree on the approach before you spend time on it.
2. Fork the repository and branch from `develop`.
3. Write tests. The project uses Jest for TypeScript and pytest for the Python workers.
4. Run the checks locally:
   ```bash
   npm run validate     # type-check, lint, test
   ```
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit subjects. Releases are cut automatically from commit messages, so `fix:` and `feat:` prefixes and `BREAKING CHANGE:` footers affect the published version.
6. Open the pull request against `develop`, not `main`.

## What we are likely to ask for

- A clear description of the problem, not only the change.
- Tests that would have failed before your change.
- No new runtime dependency without a reason in the pull request description, including its licence.
- Documentation updates where behaviour changes, under `mintlify-docs/`.

## Security

Please do not open public issues for security problems. See
[SECURITY.md](SECURITY.md).

## Questions

[info@qventu.com](mailto:info@qventu.com)
