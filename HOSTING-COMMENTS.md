# Hosting the comment page

This file is for your coding agent. It explains how to put Descant's comment page online, so the people you share an article with can read it and comment from their own browser, and their comments come back into your writing space as commits.

Descant works without it. Set it up only when you want outside readers.

## How it fits together

- **The comment page** is a small web service in `app/reviewers/` (in an installed writing space, `.descant/app/reviewers/`). It holds only the articles you share, the readers you share them with, and their comments.
- **Your Descant server** (the app on your computer) connects to it with `--share-to <url>`. Every request goes out from your computer: it pushes the shared articles and pulls the new comments. Nothing on the comment page can reach your computer, so it can stay on your machine with no open port.
- **Sign-in** is by a one-time code sent by email, for you and for your readers. You sign in with the address in `.descant/people.json`.

## Where it can run

Today the service is a Cloudflare Worker and needs these Cloudflare features: Workers, a D1 database, Email Routing (to send sign-in codes), a rate limiter, and a domain on your Cloudflare account. The free plan is enough for a few readers.

A static host (GitHub Pages, Netlify static, an S3 bucket) cannot run it: it needs a server and a database. To run it elsewhere, an agent would replace the four bindings in `src/worker/store.ts`'s `Env` (`DB` is SQLite through D1, `MAIL` sends email, `ASSETS` serves `public/`, `PUBLIC_REQUESTS` limits requests) with that host's equivalents, and apply the SQL files in `migrations/` in order. That port has not been done or tested.

## Set it up on Cloudflare

You need Node.js 22 or newer, Python 3 and a Cloudflare account with your domain on it. Work in `.descant/app/reviewers/` of your writing space.

1. **The handwriting font.** The comment page uses Rando Sans, which this repository does not include, and the build stops without it. Follow the README's "The handwriting font" section, so that `.descant/app/fonts/randosans-500-sharpie.woff2` exists.
2. **Install the tools:** `npm ci`.
3. **Configure:** copy `wrangler.example.toml` to `wrangler.toml` (git ignores it) and change:
   - `routes` and `APP_URL`: the address readers will open, for example `comments.your-domain.com`;
   - `FROM_ADDRESS` and `allowed_sender_addresses`: an address on your domain that Email Routing can send from;
   - `WRITERS`: the keys in `.descant/people.json` (the names before the colon), comma separated, for example `"ada"` or `"ada,bo"`. Each key is a lowercase letter followed by up to 23 lowercase letters, digits or hyphens (`ada`, `jean-luc`), and not `both` or `unassigned`; with no valid key nobody can sign in as a writer;
   - leave `WRITER_ORIGIN` commented out. It serves the writing app itself through the comment page, which needs your Descant server on a public HTTPS address; the comment page works without it.
4. **Database:** `npx wrangler d1 create descant`, paste the id it prints into `database_id`, then `npx wrangler d1 migrations apply descant --remote`.
5. **Email:** turn on Email Routing for your domain in the Cloudflare dashboard. Cloudflare only delivers to verified destination addresses, so add and verify your own address and each reader's before they can sign in.
6. **Secrets.** Never print them or write them into the repository:
   ```sh
   mkdir -p ~/.config/descant
   openssl rand -base64 48 | tr -d '\n' > ~/.config/descant/share-token
   chmod 600 ~/.config/descant/share-token
   shasum -a 256 < ~/.config/descant/share-token | cut -d' ' -f1 | tr -d '\n' | npx wrangler secret put SHARE_TOKEN_SHA256
   openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_SECRET
   ```
   The share token stays on your computer; the comment page keeps only its SHA-256.
7. **Deploy:** `npx wrangler deploy`. It first runs `python3 ../build.py --public-reviewer --public-writer`, which builds the page with no article text in it.
8. **Connect your Descant server.** Start it with the comment page's address:
   ```sh
   python3 .descant/app/serve.py --port 8790 --share-to https://comments.your-domain.com
   ```
   To make it permanent, add `--share-to https://comments.your-domain.com` to the last line of the `descant` launcher in your writing space, and check that line again after `install.sh --update`.

## Check that it works

- `https://comments.your-domain.com/` shows the sign-in page.
- The Descant server's terminal shows no `descant:` error within a minute of starting.
- You can sign in with the address in `.descant/people.json`, share an article with a reader from Descant's Share button, and a comment the reader leaves appears in Descant as a commit in the article's `review/` folder within a minute.

## What leaves your computer

Only articles you shared by name, as their last saved version, without `%%private notes%%`, `[NAME: ...]` markers or HTML comments. An article that still has an unclosed note does not leave at all. For every article, the comment page also receives its title, owner and status, never its text.
