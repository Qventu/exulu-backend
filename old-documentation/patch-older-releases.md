Here’s a concise README section for your backport hotfix workflow:

---

## Publishing a fix to an Older Version

To release a fix for an older version of the package:

1. Go to the GitHub repository and locate the commit corresponding to the version you want to update.
2. Copy the commit SHA.
3. Create a new branch from that commit:

```bash
git checkout -b fix/<version> <commit-sha>
```

4. Apply your changes and push the branch to GitHub:

```bash
git add .
git commit -m "fix: description of the fix"
git push origin fix/<version>
```

5. Build the package:

```bash
npm run build
```

6. Manually update the version in `package.json` to the patch version you want to publish (e.g., `1.19.2`).
7. Publish the package to npm (for private packages):

```bash
npm publish --access restricted
```

---

This ensures older versions can receive patches safely without interfering with the main release flow.

If you want, I can also make a **slightly prettier “one-paragraph” version** suitable for quick reference in the repo.
