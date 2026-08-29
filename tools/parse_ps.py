"""Extract the graded part structure of a problem set from its LaTeX body.

Reads ``psN_body.tex`` (the single source of truth for both questions and
solutions) and writes ``assets/psN.json``: one entry per problem, each with its
lettered parts, point values, and a short plain-text stub of the question.  The
composer page uses this to lay out one answer box per graded part, so the boxes
can never drift out of sync with the PDF -- rerun this whenever the .tex changes.

Only the question half of the body is read; everything inside \\ifsol ... \\fi
(solutions and rubrics) is skipped.
"""

import json
import re
import sys
from pathlib import Path

STUB_CHARS = 200


def strip_braced(text, macro):
    """Remove \\macro{...} including its (possibly nested) argument."""
    out = []
    i = 0
    needle = "\\" + macro + "{"
    while i < len(text):
        if text.startswith(needle, i):
            depth = 0
            j = i + len(needle) - 1
            while j < len(text):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            i = j + 1
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def keep_braced(text, macros):
    """Replace \\macro{inner} with inner for formatting-only macros."""
    pattern = re.compile(r"\\(" + "|".join(macros) + r")\{([^{}]*)\}")
    prev = None
    while prev != text:
        prev = text
        text = pattern.sub(r"\2", text)
    return text


def delatex(text):
    text = strip_braced(text, "footnote")
    text = strip_braced(text, "label")
    text = keep_braced(text, ["emph", "textbf", "textit", "texttt", "aitag", "text"])
    replacements = [
        (r"\\%", "%"), (r"\\\$", "$"), (r"\\&", "&"), (r"\\_", "_"),
        (r"\\#", "#"), (r"\\,", " "), (r"\\ ", " "),
        (r"\{,\}", ","), (r"---", "\u2014"), (r"--", "\u2013"),
        (r"``", "\u201c"), (r"''", "\u201d"),
        (r"\\bar\{x\}", "xbar"), (r"\\pm", "+/-"), (r"\\times", "x"),
        (r"\\sqrt", "sqrt"), (r"\\noindent", ""), (r"\\clearpage", ""),
    ]
    for pat, rep in replacements:
        text = re.sub(pat, rep, text)
    text = re.sub(r"\$([^$]*)\$", r"\1", text)          # unwrap inline math
    text = re.sub(r"\\[a-zA-Z]+\*?", " ", text)          # drop leftover macros
    text = text.replace("{", "").replace("}", "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def first_sentence(text, limit=STUB_CHARS):
    """A one-line gist of the part, for the label above its answer box."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for stop in (". ", "? ", "! "):
        idx = cut.rfind(stop)
        if idx > 60:
            return cut[: idx + 1].strip()
    return cut.rsplit(" ", 1)[0].strip() + "\u2026"


def strip_solutions(lines):
    """Drop every \\ifsol block, keeping the \\else branch where there is one."""
    kept = []
    stack = []  # True while inside the solution branch of an \ifsol
    for line in lines:
        bare = line.strip()
        if bare.startswith("\\ifsol\\else"):
            stack.append(False)
            continue
        if bare == "\\ifsol":
            stack.append(True)
            continue
        if bare == "\\else" and stack:
            stack[-1] = not stack[-1]
            continue
        if bare == "\\fi" and stack:
            stack.pop()
            continue
        if not any(stack):
            kept.append(line)
    return kept


def parse(body_path):
    raw = Path(body_path).read_text(encoding="utf-8", errors="replace").splitlines()
    lines = strip_solutions(raw)

    problems = []
    current = None
    depth = 0          # enumerate nesting inside the current problem
    part = None

    def close_part():
        nonlocal part
        if part is not None:
            text = delatex(" ".join(part["_buf"]))
            part["stub"] = first_sentence(text)
            del part["_buf"]
            current["parts"].append(part)
            part = None

    for line in lines:
        head = re.match(r"\\problemhead\{(\d+)\}\{(.*?)\}\{(.*?)\}\{(\d+)\}", line.strip())
        if head:
            close_part()
            if current:
                problems.append(current)
            current = {
                "number": int(head.group(1)),
                "title": delatex(head.group(2)),
                "ai_tag": delatex(head.group(3)),
                "points": int(head.group(4)),
                "parts": [],
            }
            depth = 0
            continue

        if current is None:
            continue

        if "\\begin{enumerate}" in line:
            depth += 1
            continue
        if "\\end{enumerate}" in line:
            close_part()
            depth -= 1
            continue

        if depth == 1:
            item = re.match(r"\\item\s*(?:\((.*?)\))?\s*(.*)", line.strip())
            if item:
                close_part()
                # Ungraded parts still consume a letter -- the composer must label
                # boxes exactly as the PDF does, or students answer under the wrong one.
                qualifier = (item.group(1) or "").strip()
                pts = re.match(r"(\d+)\s*points?$", qualifier)
                letter = chr(ord("a") + len(current["parts"]))
                part = {
                    "id": "p%d%s" % (current["number"], letter),
                    "letter": letter,
                    "points": int(pts.group(1)) if pts else 0,
                    "graded": bool(pts),
                    "_buf": [item.group(2)],
                }
                continue
            if part is not None:
                part["_buf"].append(line.strip())
        elif depth > 1 and part is not None:
            # roman sub-steps are instructions within the lettered part
            part["_buf"].append(re.sub(r"\\item", " ", line.strip()))

    close_part()
    if current:
        problems.append(current)
    return problems


def main():
    body = Path(sys.argv[1])
    out = Path(sys.argv[2])
    problems = parse(body)
    payload = {"source": body.name, "problems": problems}
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    total = 0
    for p in problems:
        letters = "".join(x["letter"] if x["graded"] else x["letter"].upper()
                          for x in p["parts"])
        part_pts = sum(x["points"] for x in p["parts"])
        total += p["points"]
        flag = "" if part_pts == p["points"] else "  <-- PARTS SUM TO %d" % part_pts
        print("Problem %d (%d pts, %s): %d parts (%s)%s"
              % (p["number"], p["points"], p["ai_tag"], len(p["parts"]), letters, flag))
    print("Total: %d points -> %s" % (total, out))


if __name__ == "__main__":
    main()
