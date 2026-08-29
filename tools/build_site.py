"""Stage everything the course site serves, from the sources of truth upstream.

Run from the website/ directory:  python tools/build_site.py

For each problem set listed in MANIFEST this:
  1. re-parses psN_body.tex into assets/psN.json (the composer's part list);
  2. rasterizes the questions PDF into files/psN/ -- every page becomes an image,
     so the posted copy has no text layer to select or paste into a chatbot;
  3. copies the datasets the set uses into files/psN/.

It also copies the lecture decks named in DECKS.  Nothing here edits the
upstream LaTeX or datasets; this directory is entirely downstream of them.

The rasterized PDF is a deterrent, not a lock: a student can still screenshot a
page and hand the image to a multimodal model.  Keep the text PDF available on
request -- a page image is unreadable to a screen reader.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import fitz  # PyMuPDF

HERE = Path(__file__).resolve().parent
SITE = HERE.parent
COURSE = SITE.parent
PS = COURSE / "2026_problem_sets"

RASTER_DPI = 150

MANIFEST = {
    "ps2": {
        "body": PS / "tex" / "ps2_body.tex",
        "questions": PS / "pdf" / "ps2_questions.pdf",
        "datasets": [
            "data_bundesliga_ghost_raw.csv",
            "data_bundesliga_ghost_readme.txt",
            "data_deliveries_raw.csv",
        ],
    },
}

DECKS = [
    ("2026_407_01_intro.pptx", "deck1_confidence_intervals.pptx"),
    ("2026_407_02_hypothesis.pptx", "deck2_hypothesis_testing.pptx"),
]


def rasterize(src, dest, dpi=RASTER_DPI):
    """Write a page-image copy of src: same pages, no selectable text.

    Each page goes in as an encoded PNG stream rather than a raw pixmap.  A raw
    pixmap is ~6 MB of samples per page, which Chrome's built-in PDF viewer
    chokes on; the encoded stream renders instantly.
    """
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pages_dir = dest.parent / "pages"
    pages_dir.mkdir(exist_ok=True)
    for old in pages_dir.glob("page-*.png"):
        old.unlink()
    count = 0
    with fitz.open(src) as doc, fitz.open() as out:
        for page in doc:
            pix = page.get_pixmap(matrix=matrix)
            png = pix.tobytes("png")
            new = out.new_page(width=page.rect.width, height=page.rect.height)
            new.insert_image(new.rect, stream=png)
            count += 1
            # the same images, loose, for the answer builder's reading pane --
            # Chrome's PDF plugin renders blank inside a narrow iframe
            (pages_dir / ("page-%02d.png" % count)).write_bytes(png)
        out.set_metadata({
            "title": "MGT 407E - reading copy (page images)",
            "producer": "407e site build",
        })
        out.save(dest, deflate=True, garbage=4)
    return count


def assert_no_text(pdf_path):
    """Fail loudly if any text survived -- the whole point is that none does."""
    with fitz.open(pdf_path) as doc:
        leaked = [p.number + 1 for p in doc if p.get_text().strip()]
    if leaked:
        sys.exit("ERROR: text layer survived on pages %s of %s" % (leaked, pdf_path))


def build_set(name, spec):
    out_dir = SITE / "files" / name
    out_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [sys.executable, str(HERE / "parse_ps.py"),
         str(spec["body"]), str(SITE / "assets" / ("%s.json" % name))],
        check=True,
    )

    raster = out_dir / ("%s_questions.pdf" % name)
    pages = rasterize(spec["questions"], raster)
    assert_no_text(raster)
    print("Rasterized %s -> %s (%d pages, %.1f MB)"
          % (spec["questions"].name, raster.name, pages, raster.stat().st_size / 1e6))

    # tell the composer how many page images its reading pane should load
    meta_path = SITE / "assets" / ("%s.json" % name)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["page_count"] = pages
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    for fname in spec["datasets"]:
        src = PS / "datasets" / fname
        if not src.exists():
            sys.exit("ERROR: missing dataset %s" % src)
        shutil.copy2(src, out_dir / fname)
    print("Copied %d dataset file(s) for %s" % (len(spec["datasets"]), name))


def build_decks():
    out_dir = SITE / "files" / "lectures"
    out_dir.mkdir(parents=True, exist_ok=True)
    for src_name, dest_name in DECKS:
        src = COURSE / "slides" / src_name
        if not src.exists():
            print("SKIP deck (not found): %s" % src_name)
            continue
        shutil.copy2(src, out_dir / dest_name)
        print("Copied deck %s -> %s (%.1f MB)"
              % (src_name, dest_name, src.stat().st_size / 1e6))


def main():
    for name, spec in MANIFEST.items():
        build_set(name, spec)
    build_decks()
    print("\nSite staged in %s" % SITE)


if __name__ == "__main__":
    main()
