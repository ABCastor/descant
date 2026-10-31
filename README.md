# Descant

Descant is a writing app that runs on your own computer and keeps every article as a plain Markdown file in a git repository you own. Each save is a commit signed with your name, so the history of a piece is its git log.

It is for people who write long pieces, revise them many times and want the drafts, comments and versions to stay in files they control. Nothing is hosted by us: the app listens on your machine only, and your writing goes wherever you choose to push it.

## Install

You need Python 3.9 or newer and git. On a Mac, `xcode-select --install` provides both.

```sh
git clone https://github.com/ABCastor/descant.git ~/descant-app
cd ~/descant-app
./install.sh --name "Your Name" --email you@example.com
```

The installer makes your writing space in `~/Descant` (choose another place with `--dir`), with two practice articles and a first commit signed by you. Start the app with `~/Descant/descant`, or double-click `Descant.command` on a Mac, and it opens `http://127.0.0.1:8790/` in your browser. Stop it with Ctrl+C.

## Where your writing lives

Your writing space is an ordinary git repository:

- `articles/` holds your writing, one folder per article, each with its `article.md`.
- `.descant/people.json` names you as the writer whose name signs each save.
- `.descant/app/` is the app itself, ignored by git.

It has no remote until you add one. Add a private remote you trust (your own server, a private GitHub repository, a folder on a synced drive) and set its upstream, and every save is pushed there too. That is your backup and your sync between computers.

## Update

```sh
cd ~/descant-app
git pull
./install.sh --update
```

This replaces the app inside your writing space and leaves your articles, their history and your name as they are. Add `--dir` if your space is not in `~/Descant`.

## The handwriting font

Descant's handwritten touches use Rando Sans, which this repository does not include; without it they fall back to another font. To use it, download Rando Sans from https://beaumaher.gumroad.com/l/rando-sans (by Beau Maher, free, SIL Open Font License), save the regular weight as `app/fonts/randosans-500-sharpie.woff2` in your copy of this repository (`~/descant-app` above), then run `./install.sh --update`. Git ignores the file there, so later updates keep it. The comment page below needs it.

## Comments from other people

To let people you share an article with read and comment from their own browser, host the comment page yourself. `HOSTING-COMMENTS.md` explains to a coding agent how to set it up and connect it.

## Publishing

Descant does not know where you publish. `PUBLISHING.md` in your writing space explains how a coding agent can connect the Publish button to your own site.

## Licence

Apache License 2.0, see `LICENSE`. Bundled fonts keep their own licences, listed in `NOTICE`.

<p><a href="https://abcastor.com"><img src="docs/castor-footer.svg" width="350" alt="Chip, the Castor beaver, Castor, we give a dam"></a></p>
