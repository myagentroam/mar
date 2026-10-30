---
title: Git History
lastUpdated: 2026-10-30
---

# Git History

Git History displays commits for the selected Git Workspace in reverse chronological order. Load older entries as needed and open a commit to inspect its metadata and file changes. Text files open a Diff against the parent commit. Supported images, audio, video, PDF, and Office formats open directly in a preview of the selected commit, never the current worktree version. Ctrl-click (Command-click on macOS) a changed file to open the same content in a separate window through the standard file preview/editor flow, retaining its commit and repository context. Deleted files do not silently fall back to a parent commit or the current version.

In the file panel, select **Git History**, then choose the root repository or an initialized submodule and one or more local or remote branches. Opening the tab, refreshing manually, or changing repositories first attempts to fetch the selected repository before reading branches and commits. If fetching fails, local records remain available with a subtle orange text notice, cleared after the next successful fetch. Changing only branch filters or loading more does not fetch again. The default page contains 50 commits; scroll near the bottom to load more automatically, and retry in place if loading fails. Root commits compare against empty content. Use Refresh to attempt another remote update. Check that the commit order matches the selected repository and branches.

History is read-only. It does not switch branches, reset files, or change `HEAD`. Use the Workspace terminal or another approved Git client for repository mutations.

Missing history usually means the directory is not a Git repository, the Node service account cannot read it, or the current Node version does not support the feature.

Commit authors, messages, and paths come from the repository. Review them against your project's security rules before sharing screenshots or exports. Next: [Workspace terminal](terminal.md).
