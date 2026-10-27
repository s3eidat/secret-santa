/* Secret Santa — crypto-random draw with exclusions. The draw lives in memory only; groups are saved only when you ask. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;
  var KEY = "santa.groups";

  // ---------- pure logic (tested) ----------
  // Unbiased crypto random integer in [0, n).
  function randInt(n) {
    var buf = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
    do { crypto.getRandomValues(buf); } while (buf[0] >= lim);
    return buf[0] % n;
  }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = randInt(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function range(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }
  // allowed[i][j]: may giver i draw receiver j? Never yourself, never someone you're paired with (both ways).
  function allowedMatrix(n, pairs) {
    var a = range(n).map(function (i) { return range(n).map(function (j) { return i !== j; }); });
    pairs.forEach(function (p) { if (p[0] < n && p[1] < n) { a[p[0]][p[1]] = false; a[p[1]][p[0]] = false; } });
    return a;
  }
  // Exact feasibility: a perfect bipartite matching giver → receiver exists (Kuhn's augmenting paths).
  function feasible(a) {
    var n = a.length, owner = range(n).map(function () { return -1; });
    function augment(i, seen) {
      for (var j = 0; j < n; j++) {
        if (!a[i][j] || seen[j]) continue;
        seen[j] = true;
        if (owner[j] < 0 || augment(owner[j], seen)) { owner[j] = i; return true; }
      }
      return false;
    }
    for (var i = 0; i < n; i++) if (!augment(i, [])) return false;
    return n > 1;
  }
  function valid(a, p) {
    var used = {};
    for (var i = 0; i < p.length; i++) { if (!a[i][p[i]] || used[p[i]]) return false; used[p[i]] = 1; }
    return p.length === a.length;
  }
  // Uniform when possible: rejection-sample random permutations (bounded); if the constraints are tight,
  // fall back to a randomized backtracking search, which always finds a valid draw when one exists.
  function draw(a, tries) {
    var n = a.length;
    if (!feasible(a)) return null;
    for (var t = 0; t < (tries || 20000); t++) { var p = shuffle(range(n)); if (valid(a, p)) return p; }
    var res = new Array(n), used = {}, order = shuffle(range(n));
    (function bt(k) {
      if (k === n) return true;
      var i = order[k], cands = shuffle(range(n));
      for (var c = 0; c < n; c++) {
        var j = cands[c];
        if (a[i][j] && !used[j]) { used[j] = 1; res[i] = j; if (bt(k + 1)) return true; used[j] = 0; }
      }
      return false;
    })(0);
    return res;
  }
  // Plain-language reason a draw is impossible, plus which exclusion to drop if one would fix it.
  function explain(names, pairs) {
    var n = names.length;
    if (n < 2) return "Add at least two people.";
    var a = allowedMatrix(n, pairs);
    for (var i = 0; i < n; i++) if (!a[i].some(Boolean)) return names[i] + " can't draw anyone: everyone else is excluded for them.";
    var fix = null;
    pairs.some(function (p, k) { var rest = pairs.filter(function (_, x) { return x !== k; }); if (feasible(allowedMatrix(n, rest))) { fix = p; return true; } return false; });
    return "No valid draw exists with these exclusions" + (fix ? ". Removing " + names[fix[0]] + " ↔ " + names[fix[1]] + " would make it work." : ". Remove some exclusions or add more people.");
  }

  // ---------- state ----------
  var st = { names: [], pairs: [], budget: "", date: "", msg: "" };
  var result = null, seen = {}, current = -1, groupName = "";

  function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
  function cleanGroup(g) {
    g = g && typeof g === "object" ? g : {};
    var names = [], low = {};
    (Array.isArray(g.names) ? g.names : []).slice(0, 200).forEach(function (x) {
      var s = str(x, 40).trim(); if (s && !low[s.toLowerCase()]) { low[s.toLowerCase()] = 1; names.push(s); }
    });
    var pairs = [];
    (Array.isArray(g.pairs) ? g.pairs : []).forEach(function (p) {
      if (Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] !== p[1] && p[0] >= 0 && p[1] >= 0 && p[0] < names.length && p[1] < names.length &&
        !pairs.some(function (q) { return (q[0] === p[0] && q[1] === p[1]) || (q[0] === p[1] && q[1] === p[0]); })) pairs.push([p[0], p[1]]);
    });
    return { names: names, pairs: pairs, budget: str(g.budget, 30), date: /^\d{4}-\d{2}-\d{2}$/.test(g.date) ? g.date : "", msg: str(g.msg, 300) };
  }
  function loadGroups() {
    var raw = S3.store(KEY), out = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) Object.keys(raw).slice(0, 50).forEach(function (k) { var n = str(k, 40).trim(); if (n) out[n] = cleanGroup(raw[k]); });
    return out;
  }

  // ---------- render setup ----------
  function niceDate(v) { if (!v) return ""; var p = v.split("-"); return new Date(+p[0], p[1] - 1, +p[2]).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" }); }
  function renderPeople() {
    var box = $("#people"); box.textContent = "";
    if (!st.names.length) box.appendChild(h("div", { "class": "empty ss-empty" }, [h("b", { text: "No one yet" }), "Add at least three names for a fun draw."]));
    st.names.forEach(function (n, i) {
      box.appendChild(h("span", { "class": "chip ss-person" }, [h("bdi", { text: n }),
        h("button", { type: "button", "class": "ss-x", "data-del": i, "aria-label": "Remove " + n, title: "Remove", html: S3.icon("x") })]));
    });
    $("#count").textContent = st.names.length ? st.names.length + (st.names.length === 1 ? " person" : " people") : "";
    ["#exA", "#exB"].forEach(function (id, k) {
      var sel = $(id), keep = sel.value; sel.textContent = "";
      st.names.forEach(function (n, i) { sel.appendChild(h("option", { value: i, text: n })); });
      sel.value = keep !== "" && +keep < st.names.length ? keep : String(Math.min(k, Math.max(0, st.names.length - 1)));
    });
    var pb = $("#pairs"); pb.textContent = "";
    st.pairs.forEach(function (p, k) {
      pb.appendChild(h("span", { "class": "chip accent" }, [h("bdi", { text: st.names[p[0]] }), " ↔ ", h("bdi", { text: st.names[p[1]] }),
        h("button", { type: "button", "class": "ss-x", "data-unpair": k, "aria-label": "Remove exclusion", html: S3.icon("x") })]));
    });
    status();
  }
  function status() {
    var el = $("#status"), n = st.names.length, ok = n >= 2 && feasible(allowedMatrix(n, st.pairs));
    el.className = "ss-status " + (ok ? "ok" : n ? "bad" : "");
    el.textContent = ok ? "Ready: " + n + " people" + (st.pairs.length ? ", " + st.pairs.length + " exclusion" + (st.pairs.length === 1 ? "" : "s") : "") + (n === 2 ? " (with two, you'll simply swap)" : "") + "." :
      n ? explain(st.names, st.pairs) : "Add the people taking part.";
    $("#draw").disabled = !ok;
  }
  function addNames(text) {
    var added = 0, low = {};
    st.names.forEach(function (n) { low[n.toLowerCase()] = 1; });
    text.split(/[\n,;،]+/).forEach(function (raw) {
      var n = raw.trim().slice(0, 40);
      if (!n) return;
      if (low[n.toLowerCase()]) { S3.toast(n + " is already in the list", "error"); return; }
      if (st.names.length >= 200) return;
      low[n.toLowerCase()] = 1; st.names.push(n); added++;
    });
    if (added) renderPeople();
    return added;
  }

  $("#name").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); if (addNames(e.target.value)) e.target.value = ""; } });
  $("#name").addEventListener("paste", function (e) {
    var t = (e.clipboardData || window.clipboardData).getData("text");
    if (/[\n,;]/.test(t)) { e.preventDefault(); addNames(t); }
  });
  $("#add").addEventListener("click", function () { var i = $("#name"); if (addNames(i.value)) i.value = ""; i.focus(); });
  $("#people").addEventListener("click", function (e) {
    var b = e.target.closest("[data-del]"); if (!b) return;
    var i = +b.dataset.del;
    st.names.splice(i, 1);
    st.pairs = st.pairs.filter(function (p) { return p[0] !== i && p[1] !== i; }).map(function (p) { return [p[0] > i ? p[0] - 1 : p[0], p[1] > i ? p[1] - 1 : p[1]]; });
    renderPeople();
  });
  $("#exAdd").addEventListener("click", function () {
    var a = +$("#exA").value, b = +$("#exB").value;
    if (st.names.length < 2) return S3.toast("Add people first", "error");
    if (a === b) return S3.toast("Pick two different people", "error");
    if (st.pairs.some(function (p) { return (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a); })) return S3.toast("That pair is already excluded", "error");
    st.pairs.push([a, b]); renderPeople();
  });
  $("#pairs").addEventListener("click", function (e) { var b = e.target.closest("[data-unpair]"); if (b) { st.pairs.splice(+b.dataset.unpair, 1); renderPeople(); } });
  ["budget", "date", "msg"].forEach(function (k) { $("#" + k).addEventListener("input", function (e) { st[k] = e.target.value; }); });

  // ---------- saved groups (only on request) ----------
  function fillGroups() {
    var g = loadGroups(), sel = $("#groups"); sel.textContent = "";
    sel.appendChild(h("option", { value: "", text: Object.keys(g).length ? "Saved groups…" : "No saved groups" }));
    Object.keys(g).forEach(function (k) { sel.appendChild(h("option", { value: k, text: k })); });
    sel.value = g[groupName] ? groupName : "";
    $("#delGroup").hidden = !g[groupName];
  }
  function setGroup(g) {
    st = cleanGroup(g);
    $("#budget").value = st.budget; $("#date").value = st.date; $("#msg").value = st.msg;
    renderPeople();
  }
  $("#groups").addEventListener("change", function (e) { var g = loadGroups()[e.target.value]; if (g) { groupName = e.target.value; setGroup(g); } fillGroups(); });
  $("#saveGroup").addEventListener("click", function () {
    if (!st.names.length) return S3.toast("Add some names first", "error");
    var n = window.prompt("Save this group (names, exclusions and details, not the draw) in this browser as:", groupName || "Family");
    if (!n || !n.trim()) return;
    var g = loadGroups(); g[n.trim().slice(0, 40)] = cleanGroup(st); groupName = n.trim().slice(0, 40);
    if (S3.store(KEY, g) === undefined) S3.toast("Couldn't save in this browser", "error"); else S3.toast("Group saved");
    fillGroups();
  });
  $("#delGroup").addEventListener("click", function () {
    var g = loadGroups(); delete g[groupName]; S3.store(KEY, Object.keys(g).length ? g : undefined);
    S3.toast("Deleted saved group “" + groupName + "”"); groupName = ""; fillGroups();
  });

  // ---------- draw + reveal ----------
  function doDraw() {
    var a = allowedMatrix(st.names.length, st.pairs), p = draw(a);
    if (!p) { status(); return; }
    result = { names: st.names.slice(), to: p, budget: st.budget, date: st.date, msg: st.msg };
    seen = {}; current = -1;
    $("#setup").hidden = true; $("#results").hidden = false;
    showPick(); buildSlips(); S3.done();
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#draw").addEventListener("click", doDraw);
  $("#redraw").addEventListener("click", function () {
    if (Object.keys(seen).length && !window.confirm("Some people have already seen their match. Draw again anyway?")) return;
    doDraw(); S3.toast("New draw made");
  });
  $("#edit").addEventListener("click", function () {
    if (Object.keys(seen).length && !window.confirm("Going back discards this draw. Continue?")) return;
    result = null; $("#results").hidden = true; $("#setup").hidden = false; $("#slips").hidden = true;
  });
  function stage(id) { ["pick", "confirm", "match"].forEach(function (x) { $("#" + x).hidden = x !== id; }); }
  function showPick() {
    stage("pick");
    var box = $("#names"); box.textContent = "";
    result.names.forEach(function (n, i) {
      box.appendChild(h("button", { type: "button", "class": "ss-name" + (seen[i] ? " seen" : ""), "data-i": i }, [
        seen[i] ? h("span", { "class": "ss-tick", html: S3.icon("check") }) : null, h("bdi", { text: n })]));
    });
    var k = Object.keys(seen).length;
    $("#seenNote").textContent = k === result.names.length ? "Everyone has seen their match. Enjoy the exchange!" : k + " of " + result.names.length + " have seen their match.";
  }
  $("#names").addEventListener("click", function (e) {
    var b = e.target.closest("[data-i]"); if (!b) return;
    current = +b.dataset.i;
    $("#confirmName").textContent = result.names[current];
    stage("confirm");
  });
  $("#notMe").addEventListener("click", showPick);
  $("#reveal").addEventListener("click", function () {
    $("#matchGiver").textContent = result.names[current];
    $("#matchName").textContent = result.names[result.to[current]];
    var d = $("#matchDetails"); d.textContent = "";
    if (result.budget) d.appendChild(h("span", { "class": "chip" }, ["Budget: ", h("bdi", { text: result.budget })]));
    if (result.date) d.appendChild(h("span", { "class": "chip" }, ["Exchange: " + niceDate(result.date)]));
    if (result.msg) d.appendChild(h("p", { "class": "ss-note", dir: "auto", text: result.msg }));
    seen[current] = true; stage("match");
  });
  $("#hide").addEventListener("click", function () { current = -1; showPick(); });

  function buildSlips() {
    var box = $("#slips"); box.textContent = "";
    result.names.forEach(function (n, i) {
      var inner = [h("span", { "class": "ss-sl-k", text: "You're buying a gift for" }), h("b", { "class": "ss-sl-to", dir: "auto", text: result.names[result.to[i]] })];
      var meta = [];
      if (result.budget) meta.push("Budget: " + result.budget);
      if (result.date) meta.push(niceDate(result.date));
      if (meta.length) inner.push(h("span", { "class": "ss-sl-meta", dir: "auto", text: meta.join(" · ") }));
      if (result.msg) inner.push(h("span", { "class": "ss-sl-msg", dir: "auto", text: result.msg }));
      box.appendChild(h("div", { "class": "ss-slip" }, [
        h("div", { "class": "ss-sl-out" }, [h("span", { "class": "ss-sl-k", text: "Secret Santa · private, for" }), h("b", { dir: "auto", text: n }), h("span", { "class": "ss-sl-fold", text: "open in private" })]),
        h("div", { "class": "ss-sl-in" }, inner),
        h("div", { "class": "ss-sl-flap" }, [h("span", { text: "↑ fold this flap up over the middle ↑" })])
      ]));
    });
  }
  function seg(el, value, onPick) {
    $$("button", el).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", function () { $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); onPick(b.dataset.v); });
    });
  }
  seg($("#view"), "phone", function (v) { $("#phoneView").hidden = v !== "phone"; $("#slipsView").hidden = v !== "slips"; $("#slips").hidden = v !== "slips"; });
  $("#print").addEventListener("click", function () { window.print(); S3.done(); });
  window.addEventListener("beforeunload", function (e) { if (result) { e.preventDefault(); e.returnValue = ""; } });

  fillGroups(); renderPeople();

  window.S3_DEMO = function () {
    setGroup({ names: ["Omar", "Sara", "Lina", "Yousef", "Huda", "Karim", "Maya"], pairs: [[0, 1], [3, 4]], budget: "20 JD", date: "2026-12-24",
      msg: "Dinner at Lina's, 7 pm. Wrap it nicely!" });
  };

  window.S3_SELFTEST = function () {
    var n = 7, pairs = [[0, 1], [3, 4], [2, 6]], a = allowedMatrix(n, pairs), ok = true, hits = {};
    for (var t = 0; t < 1000 && ok; t++) {
      var p = draw(a, 2000);
      if (!p || p.length !== n) { ok = false; break; }
      var used = {};
      for (var i = 0; i < n; i++) {
        if (p[i] === i || used[p[i]]) ok = false;
        used[p[i]] = 1; hits[i + ">" + p[i]] = 1;
        pairs.forEach(function (q) { if ((q[0] === i && q[1] === p[i]) || (q[1] === i && q[0] === p[i])) ok = false; });
      }
    }
    // Tight case that forces the backtracking fallback (tries = 0) must still respect the rules.
    var tight = allowedMatrix(4, [[0, 1], [2, 3]]), tp = draw(tight, 0), tightOk = !!tp && valid(tight, tp);
    var imp1 = !feasible(allowedMatrix(1, [])) && draw(allowedMatrix(1, []), 10) === null;
    var imp2 = !feasible(allowedMatrix(2, [[0, 1]]));
    var imp3 = !feasible(allowedMatrix(3, [[0, 1]]));             // the couple both need the third person
    var imp4 = !feasible(allowedMatrix(4, [[0, 1], [0, 2], [0, 3]]));
    var e1 = explain(["A", "B", "C"], [[0, 1]]).indexOf("Removing A ↔ B") >= 0, e2 = explain(["A", "B", "C", "D"], [[0, 1], [0, 2], [0, 3]]).indexOf("A can't draw anyone") === 0;
    var okSwap = feasible(allowedMatrix(2, [])) && feasible(allowedMatrix(4, [[0, 1], [2, 3]]));
    var g = cleanGroup({ names: ["A", "a", " B ", 5, "<i>x</i>"], pairs: [[0, 1], [1, 0], [0, 0], [0, 9], "x"], date: "soon", msg: 4 });
    var gOk = g.names.join("|") === "A|B|<i>x</i>" && g.pairs.length === 1 && g.date === "" && g.msg === "";
    // Every allowed giver→receiver edge should show up across 1000 draws (no edge starved by bias).
    var edges = 0; for (var x = 0; x < n; x++) for (var y = 0; y < n; y++) if (a[x][y]) edges++;
    return ok && Object.keys(hits).length === edges && tightOk && imp1 && imp2 && imp3 && imp4 && e1 && e2 && okSwap && gOk;
  };
})();
