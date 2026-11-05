# Project workflow

- After each requested change is completed and validated, create a new Git commit and push the current branch to `origin`. The user has granted standing authorization; do not request separate confirmation for routine commits and pushes.
- Run checks appropriate to the change and report the resulting commit and push status.
- Stage the relevant source, documentation, and test files explicitly. Keep local media, models, credentials, dependencies, and caches excluded by `.gitignore`.
- Preserve user data and unrelated edits. Do not amend commits or force-push unless the user explicitly requests it.
