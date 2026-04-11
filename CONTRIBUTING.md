# Contributing to Arkeon

Thanks for your interest in contributing. A few quick things before you open a PR.

## License

Arkeon is currently licensed under the Apache License, Version 2.0. By contributing, you agree your contribution will be licensed under the same terms.

## Contributor License Agreement (CLA)

Before we can accept your contribution, you'll need to sign our Contributor License Agreement. The CLA is a one-time agreement (per contributor) that grants Arkeon Technologies, Inc. the rights needed to include your contribution in the project and to relicense the project in the future if necessary.

You can read the full CLA in [`CLA.md`](./CLA.md). When you open your first pull request, the [CLA Assistant](https://cla-assistant.io/Arkeon-Technologies/arkeon) bot will automatically post a comment with a sign-in link. Signing takes about 30 seconds — you sign in with your GitHub account, click "I have read and agree", and that's it. You won't be asked again on future PRs.

We use a CLA (rather than just a DCO) because it gives Arkeon Technologies, Inc. the legal flexibility to evolve the project's licensing as the company grows. Your copyright stays with you — you're granting us a broad license, not assigning ownership.

## Source File Headers

Every new source file should begin with:

```
// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0
```

CI checks this automatically via the `License Headers` workflow — PRs that add source files without the header will fail the check. Auto-generated files (under `**/generated/**`) are exempt.

## Pull Requests

- Open an issue first for non-trivial changes so we can discuss the approach.
- Keep PRs focused — one logical change per PR.
- Include tests where applicable.
- Make sure CI passes before requesting review.

## Code of Conduct

Be kind, be constructive, assume good faith. Harassment or abuse of any kind will result in removal from the project.

## Questions

Open an issue or reach out at hello@arkeon.tech.
