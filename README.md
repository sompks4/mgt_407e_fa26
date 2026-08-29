# MGT 407E course site

Static site for MGT 407E (Probability and Statistics), Yale SOM, Fall 2026.
Published with GitHub Pages. Canvas remains the dropbox: nothing here collects
submissions or grades.

Everything in the published site is **downstream** of the real sources in
`..\2026_problem_sets\` and `..\slides\`. Nothing in this directory is edited by
hand except the HTML pages themselves — the PDFs, page images, datasets, and the
composer's part list are all generated.

## Rebuild

```
cd website
python tools\build_site.py
```

That does four things per problem set listed in `MANIFEST` at the top of
`tools\build_site.py`:

1. parses `psN_body.tex` into `assets\psN.json` — the part letters, point values,
   and a one-line stub per part, which is what the answer builder lays its boxes
   out from. Rerun it whenever the `.tex` changes and the boxes follow;
2. rasterizes `pdf\psN_questions.pdf` into `files\psN\psN_questions.pdf` — every
   page becomes an image, so the posted copy has no text layer to select or paste
   into a chatbot. The build aborts if any text survives;
3. writes the same page images loose into `files\psN\pages\` for the answer
   builder's reading pane;
4. copies that set's datasets into `files\psN\`, and the lecture decks named in
   `DECKS` into `files\lectures\`.

Requires PyMuPDF (`pip install pymupdf`). No LaTeX needed — build the question
PDFs upstream with `2026_problem_sets\build.ps1` first if they have changed.

## Deploy

First time:

```
gh auth login
gh repo create mgt_407e_fa26 --public --source=. --remote=origin --push
gh api repos/:owner/mgt_407e_fa26/pages -X POST -f build_type=legacy \
  -f "source[branch]=main" -f "source[path]=/"
```

The site is then at `https://<username>.github.io/mgt_407e_fa26/`, live about a
minute later. After that, every update is:

```
git add -A && git commit -m "what changed" && git push
```

## Who can see it

The site is **unlisted, not gated**. GitHub Pages has no access control — even a
private repo publishes its Pages site publicly, and private Pages exists only on
GitHub Enterprise Cloud. So anyone with the URL can read everything.

What is in place: every HTML page carries
`<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">`, and the
URL appears only in Canvas. Note that a project-repo `robots.txt` is **not** served
at the domain root, so it would do nothing here; the meta tags are what search
engines actually honor, and `nofollow` is what keeps crawlers off the PDFs and page
images, which cannot carry a tag of their own.

If this ever needs to be a real gate, the options are a class password with the
assets encrypted at build time, or hosting behind Yale NetID.

## Adding a problem set

1. Build the questions PDF upstream as usual.
2. Add an entry to `MANIFEST` in `tools\build_site.py` naming the body `.tex`,
   the questions PDF, and the datasets that set uses.
3. Copy `ps2\index.html` and `ps2\compose.html` to `ps3\`, and update the four
   `startComposer` config values at the bottom of `compose.html` plus the prose on
   `index.html`.
4. Run the build, add a card to `problem-sets.html`, commit, push.

## What is where

| Path | What it is |
|---|---|
| `index.html` | home — schedule, grading, how to work a set |
| `problem-sets.html` | the four sets |
| `lectures.html` | slide decks |
| `ai-policy.html` | the three AI tags, the checking bonus |
| `ps2\index.html` | PS2: questions PDF, datasets, pre-upload checklist |
| `ps2\compose.html` | the answer builder |
| `assets\composer.js` | the builder: draft storage, screenshots, PDF assembly |
| `assets\ps2.json` | generated — part letters, points, stubs |
| `assets\vendor\` | jsPDF 2.5.1, vendored so the page works if a CDN is blocked |
| `files\` | generated — page images, PDFs, datasets, decks |
| `tools\` | the build scripts |

## The answer builder

`ps2\compose.html` gives students one box per graded part, accepts pasted
screenshots, and assembles a `ps2_lastname_firstname.pdf` in the browser. It is
optional — Word, LaTeX, and scanned handwriting are all still fine.

Worth knowing:

- **Nothing is transmitted.** Drafts live in the student's own browser
  (IndexedDB, falling back to localStorage for text if IndexedDB is blocked).
  Clearing browsing data clears the draft, which is why the page pushes
  *Download draft*.
- **Screenshots are embedded inline** under the part they belong to, downscaled to
  1600px and re-encoded as JPEG if a PNG would be oversized. Other companion files
  (`.csv`, `.xlsx`, do-files) are listed by name in the PDF and go up as separate
  Canvas attachments — PDF-embedded attachments do not show in SpeedGrader.
- **Part labels come from the `.tex`,** including ungraded parts, so the letters
  always match the PDF. PS2's Problem 2(a) is ungraded and still occupies its
  letter.
- **jsPDF's built-in fonts are Latin-1.** `cleanText` in `composer.js` maps what
  students actually type — Greek letters, curly quotes, ±, ≤, − — and turns
  anything else into `?`. Add to `CHAR_MAP` if something new shows up in a
  submission.

## The rasterized questions PDF

Posting page images instead of text is a speed bump, not a lock: a student can
screenshot a page and hand the image to a multimodal model, which reads it as
well as text. What it does is stop one-click select-and-paste, so the prompts
students write are their own.

It also means a screen reader gets nothing from the posted file. Both the PS2 page
and the composer say a text version is available on request — keep
`2026_problem_sets\pdf\ps2_questions.pdf` handy for that, and send it without
fuss to anyone who asks.
