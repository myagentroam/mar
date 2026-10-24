---
title: Git History
lastUpdated: 2026-10-24
---

# Git History

Git History displays commits for the selected Git Workspace in reverse chronological order. Load older entries as needed and open a commit to inspect its metadata and file changes. Text files open a Diff against the parent commit. Supported images, audio, video, PDF, and Office formats open directly in a preview of the selected commit, never the current worktree version. Ctrl-click (Command-click on macOS) a changed file to open the same content in a separate window through the standard file preview/editor flow, retaining its commit and repository context. Deleted files do not silently fall back to a parent commit or the current version.

History is read-only. It does not switch branches, reset files, or change `HEAD`. Use the Workspace terminal or another approved Git client for repository mutations.

Missing history usually means the directory is not a Git repository, the Node service account cannot read it, or the current Node version does not support the feature.
