/* MGT 407E answer builder.
 *
 * Renders one answer box per graded part from assets/psN.json (generated from the
 * LaTeX body, so the labels always match the posted PDF), keeps the draft in
 * IndexedDB on the student's own machine, and assembles a submission PDF in the
 * browser with jsPDF.  Nothing leaves the computer: there is no server here.
 */

/* global jspdf */

var DB_NAME = "mgt407e";
var DB_STORE = "drafts";
var SAVE_DELAY = 600;
var MAX_IMAGE_PX = 1600;      // screenshots wider than this are downscaled
var PNG_BUDGET = 500000;      // above this, re-encode as JPEG to keep the PDF sane

/* ------------------------------------------------------------------ storage */

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function dbGet(db, key) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    tx.onsuccess = function () { resolve(tx.result); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function dbPut(db, key, value) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(value, key);
    tx.onsuccess = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

/* -------------------------------------------------------------------- utils */

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === "class") node.className = attrs[k];
    else if (k === "text") node.textContent = attrs[k];
    else if (k === "html") node.innerHTML = attrs[k];
    else node.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) { node.appendChild(c); });
  return node;
}

function slug(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30);
}

function stamp() {
  var d = new Date();
  return d.toTimeString().slice(0, 8);
}

/* jsPDF's built-in fonts are Latin-1 only.  Map what students actually type in a
   statistics course, and flag anything else rather than dropping it silently. */
var CHAR_MAP = {
  "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"',
  "–": "-", "—": "--", "…": "...", "−": "-", " ": " ",
  "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "≈": "~=",
  "≠": "!=", "√": "sqrt", "∞": "inf", "∑": "sum",
  "×": "x", "⋅": ".", "·": ".",
  "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta",
  "ε": "epsilon", "θ": "theta", "λ": "lambda", "μ": "mu",
  "µ": "mu", "π": "pi", "ρ": "rho", "σ": "sigma",
  "τ": "tau", "φ": "phi", "χ": "chi", "ω": "omega",
  "Δ": "Delta", "Σ": "Sigma", "Ω": "Omega",
  "²": "^2", "³": "^3", "⁰": "^0", "½": "1/2",
  "̂": "-hat", "̅": "-bar"
};

function cleanText(s) {
  var src = String(s == null ? "" : s).replace(/\r\n/g, "\n");
  var out = "";
  for (var i = 0; i < src.length; i++) {
    var ch = src.charAt(i);
    var code = src.charCodeAt(i);
    if (CHAR_MAP[ch] !== undefined) out += CHAR_MAP[ch];
    else if (ch === "\n" || (code >= 0x20 && code <= 0x7e)) out += ch;
    else if (code >= 0xa1 && code <= 0xff) out += ch;   // Latin-1: safe in the base fonts
    else out += "?";
  }
  return out;
}

/* --------------------------------------------------------------- main entry */

function startComposer(config) {
  var state = {
    meta: { last: "", first: "" },
    answers: {},
    images: {},
    checks: { check1: "", check2: "" },
    files: [],
    hours: "",
    updated: null
  };
  var problems = [];
  var db = null;
  var saveTimer = null;
  var lastFocusedPart = null;

  var statusEl = document.getElementById("status");
  var progressEl = document.getElementById("progress");

  function setStatus(msg) { statusEl.textContent = msg; }

  function scheduleSave() {
    clearTimeout(saveTimer);
    setStatus("Saving…");
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  function save() {
    saveTimer = null;
    state.updated = new Date().toISOString();
    if (!db) {
      try {
        var light = JSON.parse(JSON.stringify(state));
        light.images = {};           // localStorage cannot hold screenshots
        localStorage.setItem("mgt407e-" + config.setId, JSON.stringify(light));
        setStatus("Saved (text only) " + stamp());
      } catch (e) {
        setStatus("Could not save — download a draft to be safe");
      }
      return;
    }
    dbPut(db, config.setId, state).then(function () {
      setStatus("Saved " + stamp());
    }, function () {
      setStatus("Could not save — download a draft to be safe");
    });
  }

  /* ------------------------------------------------------------- rendering */

  function partAnswered(part) {
    var text = (state.answers[part.id] || "").trim();
    var imgs = state.images[part.id] || [];
    return text.length > 0 || imgs.length > 0;
  }

  function updateProgress() {
    var graded = [];
    problems.forEach(function (p) {
      p.parts.forEach(function (part) { if (part.graded) graded.push(part); });
    });
    var done = graded.filter(partAnswered).length;
    progressEl.textContent = done + " of " + graded.length + " parts answered";
    progressEl.className = "progress-pill" + (done === graded.length ? " complete" : "");
    graded.forEach(function (part) {
      var card = document.getElementById("part-" + part.id);
      if (card) card.classList.toggle("answered", partAnswered(part));
    });
  }

  function renderThumbs(part) {
    var box = document.getElementById("thumbs-" + part.id);
    box.innerHTML = "";
    (state.images[part.id] || []).forEach(function (img, idx) {
      var pic = el("img", { src: img.dataUrl, alt: img.name || "attached image" });
      var kill = el("button", { type: "button", title: "Remove", text: "×" });
      kill.addEventListener("click", function () {
        state.images[part.id].splice(idx, 1);
        renderThumbs(part);
        updateProgress();
        scheduleSave();
      });
      box.appendChild(el("div", { class: "thumb" }, [pic, kill]));
    });
  }

  function processImage(file, part) {
    if (!file || file.type.indexOf("image/") !== 0) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";              // flatten transparency for print
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL("image/png");
        var fmt = "PNG";
        if (dataUrl.length > PNG_BUDGET) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.88);
          fmt = "JPEG";
        }
        if (!state.images[part.id]) state.images[part.id] = [];
        state.images[part.id].push({
          name: file.name || "pasted screenshot",
          dataUrl: dataUrl, fmt: fmt, w: w, h: h
        });
        renderThumbs(part);
        updateProgress();
        scheduleSave();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function renderPart(part, problem) {
    var head = el("div", { class: "part-head" }, [
      el("span", { class: "part-id", text: problem.number + "(" + part.letter + ")" }),
      el("span", {
        class: "part-pts",
        text: part.graded ? part.points + (part.points === 1 ? " point" : " points") : "ungraded"
      })
    ]);

    var area = el("textarea", {
      id: "ta-" + part.id,
      "aria-label": "Answer to problem " + problem.number + " part " + part.letter,
      placeholder: part.graded
        ? "Your answer. Paste prompts, AI output, and numbers here; paste screenshots straight into this box."
        : "Optional — nothing to submit for this part."
    });
    area.value = state.answers[part.id] || "";
    area.addEventListener("input", function () {
      state.answers[part.id] = area.value;
      updateProgress();
      scheduleSave();
    });
    area.addEventListener("focus", function () { lastFocusedPart = part; });
    area.addEventListener("paste", function (ev) {
      var items = (ev.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          ev.preventDefault();
          processImage(items[i].getAsFile(), part);
        }
      }
    });

    var picker = el("input", { type: "file", accept: "image/*", multiple: "multiple", hidden: "hidden" });
    picker.addEventListener("change", function () {
      Array.prototype.forEach.call(picker.files, function (f) { processImage(f, part); });
      picker.value = "";
    });
    var addBtn = el("button", { type: "button", class: "btn secondary btn-sm", text: "Add image" });
    addBtn.addEventListener("click", function () { picker.click(); });

    var attach = el("div", { class: "attach-row" }, [
      addBtn, picker,
      el("span", { class: "attach-hint", text: "or paste a screenshot into the box above, or drop a file here" })
    ]);

    var card = el("div", {
      class: "part" + (part.graded ? "" : " ungraded"),
      id: "part-" + part.id
    }, [head]);
    if (part.stub) card.appendChild(el("p", { class: "part-stub", text: part.stub }));
    card.appendChild(area);
    card.appendChild(attach);
    card.appendChild(el("div", { class: "thumbs", id: "thumbs-" + part.id }));

    card.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    card.addEventListener("drop", function (ev) {
      ev.preventDefault();
      Array.prototype.forEach.call(ev.dataTransfer.files, function (f) { processImage(f, part); });
    });

    return card;
  }

  /* The reading pane: the questions as page images beside the answer boxes.
     Loose PNGs rather than an embedded PDF -- Chrome's plugin renders blank in a
     narrow iframe, and images behave identically everywhere, phones included. */
  function renderQuestionPages(count) {
    var host = document.getElementById("question-pages");
    if (!host || !count) return;
    for (var i = 1; i <= count; i++) {
      var num = i < 10 ? "0" + i : String(i);
      host.appendChild(el("img", {
        src: config.pagesDir + "page-" + num + ".png",
        alt: "Page " + i + " of the problem set",
        loading: i > 2 ? "lazy" : "eager",
        draggable: "false"
      }));
    }
  }

  function renderProblems() {
    var host = document.getElementById("problems");
    host.innerHTML = "";
    problems.forEach(function (problem) {
      var head = el("div", { class: "problem-head" }, [
        el("h2", { text: "Problem " + problem.number + ". " + problem.title }),
        el("span", { class: "tag", text: problem.ai_tag }),
        el("span", { class: "part-pts", text: problem.points + " points" })
      ]);
      var block = el("div", { class: "problem-block" }, [head]);
      problem.parts.forEach(function (part) {
        block.appendChild(renderPart(part, problem));
      });
      host.appendChild(block);
    });
    Object.keys(state.images).forEach(function (id) {
      var part = findPart(id);
      if (part) renderThumbs(part);
    });
  }

  function findPart(id) {
    for (var i = 0; i < problems.length; i++) {
      for (var j = 0; j < problems[i].parts.length; j++) {
        if (problems[i].parts[j].id === id) return problems[i].parts[j];
      }
    }
    return null;
  }

  /* ------------------------------------------------- companion file entries */

  function renderFiles() {
    var host = document.getElementById("file-list");
    host.innerHTML = "";
    state.files.forEach(function (entry, idx) {
      var name = el("input", { type: "text", placeholder: "filename, e.g. ps2_p1_managers.csv" });
      name.value = entry.name || "";
      name.addEventListener("input", function () { entry.name = name.value; scheduleSave(); });

      var note = el("input", { type: "text", placeholder: "what it is, and which part refers to it" });
      note.value = entry.note || "";
      note.addEventListener("input", function () { entry.note = note.value; scheduleSave(); });

      var kill = el("button", { type: "button", class: "btn secondary btn-sm", text: "Remove" });
      kill.addEventListener("click", function () {
        state.files.splice(idx, 1);
        renderFiles();
        scheduleSave();
      });

      host.appendChild(el("div", { class: "file-row" }, [name, note, kill]));
    });
  }

  /* --------------------------------------------------------- PDF assembly  */

  function buildPdf() {
    var doc = new jspdf.jsPDF({ unit: "pt", format: "letter", compress: true });
    var M = 54, PW = 612, PH = 792;
    var CW = PW - 2 * M;
    var BOTTOM = PH - M - 20;
    var y = M;
    var name = state.meta.last + ", " + state.meta.first;

    function need(h) {
      if (y + h > BOTTOM) { doc.addPage(); y = M; return true; }
      return false;
    }

    function write(str, opts) {
      opts = opts || {};
      var size = opts.size || 10.5;
      var style = opts.style || "normal";
      var indent = opts.indent || 0;
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(opts.grey ? 110 : 26);
      var lh = size * 1.38;
      var paragraphs = cleanText(str).split("\n");
      paragraphs.forEach(function (para) {
        if (para.trim() === "") { y += lh * 0.5; return; }
        doc.splitTextToSize(para, CW - indent).forEach(function (line) {
          need(lh);
          doc.text(line, M + indent, y + size * 0.92);
          y += lh;
        });
      });
      y += opts.gap === undefined ? 5 : opts.gap;
      doc.setTextColor(26);
    }

    function rule(weight) {
      need(8);
      var heavy = weight === "heavy";
      if (heavy) doc.setDrawColor(0, 53, 107);   // SOM blue, matching the LaTeX sets
      else doc.setDrawColor(190, 190, 190);
      doc.setLineWidth(heavy ? 1.1 : 0.5);
      doc.line(M, y, PW - M, y);
      y += 10;
    }

    function placeImage(img) {
      var w = img.w, h = img.h;
      var s = Math.min(CW / w, 1);
      w *= s; h *= s;
      var pageSpace = BOTTOM - M;
      if (h > pageSpace) { var s2 = pageSpace / h; w *= s2; h *= s2; }
      if (y + h + 10 > BOTTOM) { doc.addPage(); y = M; }
      doc.addImage(img.dataUrl, img.fmt || "PNG", M, y, w, h);
      y += h + 10;
    }

    /* header */
    write(config.course, { size: 9, style: "bold", grey: true, gap: 1 });
    write(config.setTitle, { size: 16, style: "bold", gap: 2 });
    write(name, { size: 12, gap: 1 });
    write("Assembled " + new Date().toLocaleString(), { size: 9, grey: true, gap: 6 });
    rule("heavy");

    /* problems, one per page */
    problems.forEach(function (problem, pi) {
      if (pi > 0) { doc.addPage(); y = M; }
      write("Problem " + problem.number + ". " + problem.title +
            "  (" + problem.points + " points)", { size: 13, style: "bold", gap: 3 });
      rule();
      problem.parts.forEach(function (part) {
        var answer = (state.answers[part.id] || "").trim();
        var imgs = state.images[part.id] || [];
        if (!part.graded && !answer && !imgs.length) return;

        need(40);
        write(problem.number + "(" + part.letter + ")" +
              (part.graded ? "   " + part.points + (part.points === 1 ? " point" : " points")
                           : "   ungraded"),
              { size: 11, style: "bold", gap: 2 });
        if (answer) write(answer, { size: 10.5, gap: 6 });
        else write("[left blank]", { size: 10.5, style: "italic", grey: true, gap: 6 });
        imgs.forEach(placeImage);
      });
    });

    /* closing sections */
    doc.addPage();
    y = M;
    write("Checking bonus (+2)", { size: 13, style: "bold", gap: 3 });
    rule();
    [["Check 1", state.checks.check1], ["Check 2", state.checks.check2]].forEach(function (pair) {
      write(pair[0], { size: 11, style: "bold", gap: 2 });
      write(pair[1] && pair[1].trim() ? pair[1] : "[not claimed]",
            pair[1] && pair[1].trim() ? { gap: 8 } : { style: "italic", grey: true, gap: 8 });
    });

    write("Companion files uploaded to Canvas with this PDF", { size: 13, style: "bold", gap: 3 });
    rule();
    var named = state.files.filter(function (f) { return (f.name || "").trim(); });
    if (named.length) {
      named.forEach(function (f) {
        write("- " + f.name + (f.note ? " -- " + f.note : ""), { gap: 2, indent: 6 });
      });
      y += 6;
    } else {
      write("[none]", { style: "italic", grey: true, gap: 8 });
    }

    write("One Last Question (ungraded, but required)", { size: 13, style: "bold", gap: 3 });
    rule();
    write("Total time spent on this problem set: " +
          (state.hours.trim() ? state.hours : "[not answered]"),
          state.hours.trim() ? {} : { style: "italic", grey: true });

    /* footers */
    var pages = doc.getNumberOfPages();
    for (var p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(120);
      doc.text(cleanText(name + "  |  " + config.setTitle), M, PH - 30);
      doc.text("Page " + p + " of " + pages, PW - M, PH - 30, { align: "right" });
    }
    return doc;
  }

  function generate() {
    if (!state.meta.last.trim() || !state.meta.first.trim()) {
      alert("Please fill in your first and last name first — they go on every page, " +
            "and they set the filename Canvas expects.");
      document.getElementById("meta-last").focus();
      return;
    }
    var missing = [];
    problems.forEach(function (problem) {
      problem.parts.forEach(function (part) {
        if (part.graded && !partAnswered(part)) {
          missing.push(problem.number + "(" + part.letter + ")");
        }
      });
    });
    if (missing.length) {
      var shown = missing.slice(0, 14).join(", ");
      if (missing.length > 14) shown += ", and " + (missing.length - 14) + " more";
      if (!confirm("These graded parts have no answer yet:\n\n" + shown +
                   "\n\nGenerate the PDF anyway? They will be marked [left blank].")) {
        return;
      }
    }
    setStatus("Building the PDF…");
    try {
      var doc = buildPdf();
      doc.save(config.setId + "_" + slug(state.meta.last) + "_" + slug(state.meta.first) + ".pdf");
      setStatus("PDF downloaded " + stamp() + " — open it and read it before uploading");
    } catch (err) {
      setStatus("PDF failed — see the message");
      alert("Something went wrong building the PDF:\n\n" + err.message +
            "\n\nDownload your draft so nothing is lost, then email Peter or Jacob.");
    }
  }

  /* --------------------------------------------------------------- wiring  */

  function bindMeta() {
    [["meta-last", "last"], ["meta-first", "first"]].forEach(function (pair) {
      var input = document.getElementById(pair[0]);
      input.value = state.meta[pair[1]] || "";
      input.addEventListener("input", function () {
        state.meta[pair[1]] = input.value;
        document.getElementById("filename-preview").innerHTML =
          "Your file will be named <code>" + config.setId + "_" +
          (slug(state.meta.last) || "lastname") + "_" +
          (slug(state.meta.first) || "firstname") + ".pdf</code>.";
        scheduleSave();
      });
    });
    ["check1", "check2"].forEach(function (key) {
      var area = document.getElementById(key);
      area.value = state.checks[key] || "";
      area.addEventListener("input", function () {
        state.checks[key] = area.value;
        scheduleSave();
      });
    });
    var hours = document.getElementById("hours");
    hours.value = state.hours || "";
    hours.addEventListener("input", function () { state.hours = hours.value; scheduleSave(); });

    document.getElementById("add-file").addEventListener("click", function () {
      state.files.push({ name: "", note: "" });
      renderFiles();
      scheduleSave();
    });

    document.getElementById("make-pdf").addEventListener("click", generate);

    document.getElementById("save-draft").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(state)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = config.setId + "_draft_" + (slug(state.meta.last) || "draft") + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus("Draft downloaded " + stamp());
    });

    var draftInput = document.getElementById("draft-input");
    document.getElementById("load-draft").addEventListener("click", function () {
      draftInput.click();
    });
    draftInput.addEventListener("change", function () {
      var file = draftInput.files[0];
      if (!file) return;
      if (!confirm("Loading a draft replaces everything currently on this page. Continue?")) {
        draftInput.value = "";
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var loaded = JSON.parse(reader.result);
          state.meta = loaded.meta || state.meta;
          state.answers = loaded.answers || {};
          state.images = loaded.images || {};
          state.checks = loaded.checks || state.checks;
          state.files = loaded.files || [];
          state.hours = loaded.hours || "";
          renderProblems();
          renderFiles();
          bindMetaValues();
          updateProgress();
          save();
          setStatus("Draft loaded " + stamp());
        } catch (e) {
          alert("That file could not be read as a PS2 draft.");
        }
        draftInput.value = "";
      };
      reader.readAsText(file);
    });

    var toggle = document.getElementById("toggle-pdf");
    toggle.addEventListener("click", function () {
      var hidden = document.body.classList.toggle("pdf-hidden");
      toggle.textContent = hidden ? "Show questions" : "Hide questions";
    });
  }

  function bindMetaValues() {
    document.getElementById("meta-last").value = state.meta.last || "";
    document.getElementById("meta-first").value = state.meta.first || "";
    document.getElementById("check1").value = state.checks.check1 || "";
    document.getElementById("check2").value = state.checks.check2 || "";
    document.getElementById("hours").value = state.hours || "";
  }

  /* ------------------------------------------------------------- start up  */

  fetch(config.dataUrl)
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      problems = data.problems;
      renderQuestionPages(data.page_count);
      return openDb().then(function (opened) {
        db = opened;
        return dbGet(db, config.setId);
      }).catch(function () {
        try {
          var raw = localStorage.getItem("mgt407e-" + config.setId);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      });
    })
    .then(function (saved) {
      if (saved) {
        state.meta = saved.meta || state.meta;
        state.answers = saved.answers || {};
        state.images = saved.images || {};
        state.checks = saved.checks || state.checks;
        state.files = saved.files || [];
        state.hours = saved.hours || "";
      }
      document.getElementById("loading").hidden = true;
      document.getElementById("composer").hidden = false;
      renderProblems();
      renderFiles();
      bindMeta();
      bindMetaValues();
      updateProgress();
      setStatus(saved ? "Draft restored" : "Ready");
    })
    .catch(function (err) {
      document.getElementById("loading").textContent =
        "The problem set could not be loaded (" + err.message + "). " +
        "Reload the page; if it keeps failing, email Peter or Jacob and use Word instead.";
    });

  window.addEventListener("beforeunload", function (ev) {
    if (saveTimer) { save(); ev.preventDefault(); ev.returnValue = ""; }
  });
}
