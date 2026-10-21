# Public release checks

The release inventory is defined in `scripts/public-content.mjs`. `public-content.config.json` records approved public service hosts, reviewed binary hashes, and exceptions scoped to exact files and line contents. Exceptions require a reason; never skip the entire test directory.

## Checking candidate content

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
```

By default, checks cover tracked files and unignored new files. Local credentials, task records, logs, installed configuration, and other files outside the release inventory must not enter the candidate. Output includes only file names, line numbers, and categories, never matching values. Allowlist changes also require code review.

Build checks cover generated JavaScript, HTML, and source maps. Use `npm run check:public -- --root <directory>` to check a directory, extracted attachment, or candidate snapshot. This mode checks everything except the Git control directory. Extract archives into a dedicated directory before checking; scanning the archive name is insufficient. Screenshots, prose, and new media still require manual review. Unreviewed binaries are blocked.

## Creating an independent public snapshot

```powershell
npm.cmd run prepare:public
# Or choose a new directory that does not already exist
npm.cmd run prepare:public -- --output C:\path\to\new-public-checkout
```

The script validates and freezes candidate files, copies them into a new directory, removes history-scan exemptions, enables a single-root history check, rescans the copy, and creates an initial commit. It does not copy existing Git history, remotes, local configuration, task data, or dependencies. It never overwrites an existing directory or pushes. If source files or the inventory change during export, it aborts; stabilize the source and retry in a new directory. Never publish a failed export.

The default destination is inside the locally ignored `.data/` directory. The command returns its location and check results. Install dependencies there and run tests and build checks. Only a verified independent snapshot is suitable for initial publication; development branches may still inherit unsuitable history.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run check:public -- --history
npm.cmd run check:public -- --build
```

`--history` checks all locally reachable refs, commit/tag metadata, historical paths, and contents, including deleted or renamed files. The checked commits, tags, and branches must match the intended publication. Never mirror-push all development refs. Use reviewed public email addresses for future contributions to avoid exposing personal or internal company addresses.

If history must be retained, clean it in a separate copy and rescan every intended public ref. Revoke or rotate real leaked credentials before rewriting records. See [GitHub's sensitive-data removal guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Before publication

- Pass snapshot and intended-history checks, installation, build, and tests.
- Verify documentation links, credential-free examples, and reviewed runtime endpoints.
- Ensure instructions describe system credential storage and the required re-login after upgrading from JSON files. Validate native dependency installation and distinguish tested Windows storage from unverified macOS/Linux client workflows.
- Exclude legacy credential files, generated Codex/Cursor configurations, and Cursor backups, which may contain unrelated services' secrets.
- Create release attachments only from the reviewed directory, excluding local workspaces and private reports.
- Inspect new images, screenshots, audio, video, and metadata individually. Use shared diagnostic copies for issue reports.
- Enable applicable GitHub secret scanning and push protection as supplementary safeguards. They do not replace checks for plugin fields, internal information, or local paths. See [GitHub secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning).

Protocol fields, model enums, service addresses, and legacy media-address decoding constants remain visible in source. Decoding constants provide no access authorization and must not be treated as private storage or access control. Redaction checks do not change server authorization or storage policies.

For source archives, use `git archive` on the reviewed public commit. Do not compress the entire working directory, which may include `.git`, dependencies, build caches, or later private reports.

## Delivery to collaborators

Maintain company collaboration history separately from independent delivery history. Delivery branches must contain only reviewed public content. Recipients should use `git clone --single-branch --no-tags --branch <delivery-branch> <repository-url>`. Never merge other collaboration branches, tags, or history into that branch. Before later publication, rerun history and build checks and explicitly push only the reviewed branch.

The scanner fingerprints internal hostnames and project identifiers; public rules and tests use synthetic fixtures. Independent snapshots carry no history-scan exemptions. Foreign history roots and unredacted commit emails are blocked.
