# Publishing from this writing space

This file is for your coding agent (Claude Code, Codex, Cursor or similar). Descant does not publish anything on its own yet: in this space its Publish command only says that publishing is not set up. Your agent's job is to give you a way to publish an article to wherever you publish (a static site, Ghost, WordPress, Substack, a newsletter), built for your setup.

## What your agent can rely on

Every article is a folder under `articles/`, and its text is `article.md`: plain Markdown with a short header (front matter). Descant saves by committing to git on `main`, so the committed `article.md` is the article; there is no database. A header looks like this:

```yaml
---
title: The article's title
subtitle: An optional line under the title
slug: the-article-s-title
language: en
published: false
tags:
  - one-tag
---
```

Your agent may add header fields your platform needs (`date`, `canonical`, `cover`). Descant keeps fields it does not know.

Inside the body, text between `%%` marks is a private note to yourself and must never be published; the same goes for everything in `materials/`, `review/` (comments) and `drafts/`. Images live in the article's `images/` folder and are linked by relative path.

## What to build

Ask your agent for one command, for example `./publish.sh articles/<folder>`, that:

1. reads the committed `article.md` (refuse when it has unsaved or uncommitted changes),
2. strips the `%%` notes and turns the header into whatever your platform expects,
3. copies the images it links to,
4. publishes, or prepares a draft on your platform for you to press Publish yourself,
5. sets `published: true` in the header and commits that change with a message saying where it went.

Keep credentials out of this folder: it is a git repository and may one day be pushed somewhere. Use your platform's own login, your system keychain or a password manager.

## Running Descant

`./descant` (or double-click `Descant.command` on a Mac) starts the app on `http://127.0.0.1:8790/`, which only this computer can reach. The app's code is in `.descant/app/`, ignored by git. `.descant/app/people.json` names who writes here; add a second person there (a short lowercase key, then `Name <email>`) and run `python3 .descant/app/build.py --world typewell` to let them sign their own saves.
