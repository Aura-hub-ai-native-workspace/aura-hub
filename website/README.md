# AURA Hub — Website Source

> **This folder is mirrored, not canonical.** The website now deploys from
> its own repository, [`aura-hub-website`](https://github.com/Aura-hub-ai-native-workspace/aura-hub-website),
> which is what Cloudflare Pages is connected to. Cloudflare was
> misdetecting this monorepo as a Worker/Node project when connected here
> directly, so the deployable site was split out. Make edits in the
> `aura-hub-website` repo directly, or edit here first and copy
> `index.html` / `assets/` across afterward; either way, do not connect
> Cloudflare Pages to this path.

A single, self-contained static page (`index.html` + `assets/`) — no build
step, no framework, no dependencies. It's the same content published as a
live preview at the Artifact link in the PR/task that added it; this
folder is the deployable source so it can be hosted anywhere real.

Design language is pulled directly from the product's own tokens
(`docs/DESIGN.md` — canvas `#0b0d11`, accent `#3b6bff`/`#5c86ff`, Inter,
large radii) and its real screenshots (`assets/screenshots/`, copied from
`docs/assets/screenshots/`) — nothing here was invented independently of
the actual app.

## Deploy it

Any static host works, since it's one HTML file + one image folder:

```bash
# Vercel
npx vercel website --prod

# Netlify
npx netlify deploy --dir=website --prod

# GitHub Pages (from repo root)
# Settings → Pages → Deploy from branch → /website
```

## Before this goes live — placeholders to replace

- **Contact email.** Every `mailto:` on the page (footer "Contact" link,
  the "Early Access" modal's submit handler) currently points at
  `hello@aurahub.dev` — a placeholder, not a real registered address.
  Replace every occurrence with the real project contact before sharing
  this publicly, or the mail simply won't deliver.
- **"Download AURA Hub."** There's no signed installer yet. The button
  opens an "Early Access" modal that collects an email via `mailto:`
  (no backend — this repo has none, and Artifacts have no storage
  capability either) rather than a fake "you're on the list" that goes
  nowhere. Swap in a real form backend (Formspree, your own API, an
  email service) when one exists; the modal markup/JS is isolated in
  `#modal` / the `early-access-form` handler for an easy swap.
- **"Watch Demo."** No video has been recorded. The Demo section is an
  interactive real-screenshot carousel instead of a fake video embed —
  see `#demo-frame` / the carousel script at the bottom of the file.
  Drop in a real `<video>` there once one exists; nothing else on the
  page needs to change.

## Updating

If a section's copy or a stat (provider count, template count) goes
stale, edit `index.html` directly — it's plain HTML/CSS, no build step.
If the screenshots change, re-copy the updated files from
`../docs/assets/screenshots/` into `assets/screenshots/` under the same
filenames.
