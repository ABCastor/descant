# This folder

A writing space for Descant, a writing app that keeps every article as plain Markdown in git. Articles live in `articles/<folder>/article.md`; each save in Descant is a commit on `main` signed by the person writing. `check.sh` is the gate every save passes: run it before you commit a change of your own. `.mentions.json` is Descant's queue of @agent and @name notes; leave it to the app.

When asked to rewrite an article or a passage, write the new text beside it, never over it: save it as `articles/<folder>/drafts/<writer>/<YYYY-MM-DD>-<slug>.md`, where `<writer>` is the writer's key in `.descant/people.json` (not their name) and `<slug>` is lowercase letters, digits and hyphens, with `title:`, `by:` (you and your model) and `base:` (the commit of `article.md` you started from) in its front matter, and commit that file on its own, with plain (LF) line endings. Descant shows no other path in Versions. The writer compares it with the article in Versions and takes the paragraphs they want. An edit the writer asks for in the article itself, a named sentence or paragraph, is still made in `article.md`.

When asked to edit an article, keep each paragraph on one source line, leave the `%%` notes alone unless asked, and never publish `materials/`, `review/` or `drafts/`. To set up publishing, read `PUBLISHING.md`.

Descant shows "Not backed up" while this repository has no copy anywhere else. To back it up, add a private remote, push `main` with an upstream (`git push -u origin main`), then restart `./descant`: with an upstream branch it pushes every save. The app's code is in `.descant/app/` (ignored by git); do not edit it to change an article.
