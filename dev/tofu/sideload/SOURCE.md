# Where these files come from

Tofu (2026-10-25): this folder is Tofu's addition; it is not part of upstream Wiki.js.

`en.json` and `locales.json` are copied unchanged from upstream's localization repository,
https://github.com/Requarks/wiki-localization at commit `6b0826df8e7a0c25841102a68184f61e5a81e1c1`, which is licensed
under the GNU Affero General Public License v3.0, the same licence as Wiki.js (`LICENSE` at the root of this repository).

They are the files Wiki.js's offline mode reads from `data/sideload` (the root `Dockerfile` copies this folder there):
`server/core/sideloader.js` imports each locale `locales.json` lists that has its own file here, which is English alone,
so the copy's interface has its words without downloading them from upstream's graph.requarks.io.
