"use strict";

const state = { revision: null, item: null, sequence: 0, expires: 0, originLink: null, timer: null };
const $ = (id) => document.getElementById(id);
const el = (name, attrs = {}, text = null) => {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== null) node.textContent = text;
  return node;
};
const announce = (message) => { $("live").textContent = message; };
const isDetail = () => location.pathname.startsWith("/items/");

function titleFor(item) {
  const labels = {
    actionable: "Plan review needed", verified_waiting: "Review verified · Awaiting runner confirmation",
    revision_changed: "Revision changed while you were reviewing", evidence_unavailable: "Review evidence unavailable",
    github_unavailable: "Couldn’t confirm current PR revision", rejected: "Changes requested",
    implementation_next: "Plan review complete · Implementation next",
    implementation_review: "Implementation review pending", post_plan: "Plan review complete",
    delivery_ready: "Delivery ready for review", runner_failed: "Delivery runner failed",
    eligibility_unavailable: "Reviewer eligibility unavailable",
    waiting: "Review request unavailable"
  };
  return labels[item.state] || "Delivery status";
}

async function load({ force = false, revision = null, focus = false } = {}) {
  const sequence = ++state.sequence;
  const endpoint = force ? "/api/action-check" : "/api/item";
  const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
  if (force) withdrawActions("Checking current revision…");
  try {
    const response = await fetch(endpoint + query, { credentials: "same-origin", cache: "no-store" });
    if (sequence !== state.sequence) return null;
    if (response.status === 401) {
      if (sessionStorage.getItem("oauth-attempted")) { renderSignIn(); return null; }
      sessionStorage.setItem("oauth-attempted", "1"); location.assign("/auth/github"); return null;
    }
    if (response.status === 403) { renderAccessDenied(); return null; }
    const data = await response.json();
    if (!response.ok || data.status === "unavailable") throw new Error("unavailable");
    if (data.status === "stale") { await load({ focus: true }); return null; }
    state.revision = data.revision;
    state.item = data.item;
    state.expires = Date.now() + data.fresh_for_ms;
    sessionStorage.removeItem("oauth-attempted");
    clearTimeout(state.timer);
    if (data.fresh_for_ms > 0 && data.item.review) {
      state.timer = setTimeout(() => {
        withdrawActions("Checking current revision…");
        announce("Checking current revision");
        load({ force: true, revision: state.revision });
      }, data.fresh_for_ms);
    }
    render(data.item, focus);
    return data;
  } catch (_) {
    if (sequence !== state.sequence) return null;
    renderUnavailable();
    return null;
  }
}

function render(item, focus = false) {
  renderInbox(item);
  renderDetail(item);
  document.body.classList.toggle("detail-route", isDetail());
  if (focus) requestAnimationFrame(() => $("detail-title")?.focus());
}

function renderInbox(item) {
  const list = $("items"); list.replaceChildren();
  const active = ["actionable", "verified_waiting", "rejected", "waiting", "evidence_unavailable", "revision_changed", "github_unavailable"].includes(item.state);
  if (!active) { $("feed-status").textContent = "You’re caught up"; return; }
  $("feed-status").textContent = "Needs action · 1";
  const link = el("a", { href: `/items/${encodeURIComponent(item.delivery_id)}`, class: "item-link",
    "aria-current": isDetail() ? "page" : "false" });
  link.append(el("span", { class: "item-title" }, titleFor(item)),
              el("span", { class: "item-meta" }, `${item.repo} · Draft PR #${item.pr.number} · ${item.pr.head_sha.slice(0, 7)}`));
  link.addEventListener("click", (event) => {
    if (matchMedia("(min-width: 721px)").matches) {
      event.preventDefault(); state.originLink = link; history.pushState({}, "", link.href);
      document.body.classList.add("detail-route"); $("detail-title")?.focus();
    }
  });
  const row = el("li"); row.append(link); list.append(row);
}

function renderDetail(item) {
  const body = $("detail-body"); body.replaceChildren();
  body.append(el("p", { class: "eyebrow" }, "Delivery · Plan"));
  const heading = el("h2", { id: "detail-title", tabindex: "-1" }, titleFor(item)); body.append(heading);
  body.append(el("p", { class: "meta" }, `${item.repo} · Issue #${item.issue ?? "—"} · Draft PR #${item.pr.number}`));
  if (item.issue_title) body.append(el("p", {}, item.issue_title));
  body.append(el("p", {}, `Revision ${item.generation}`));
  body.append(el("p", { class: "sha" }, item.pr.head_sha));
  const evidenceActions = el("div", { class: "actions" });
  const copySha = el("button", { type: "button" }, "Copy full SHA");
  copySha.addEventListener("click", async () => { await navigator.clipboard.writeText(item.pr.head_sha); announce("Full commit SHA copied"); });
  evidenceActions.append(link("Open exact commit", item.pr.commit_url), copySha); body.append(evidenceActions);
  body.append(el("h3", {}, "Review evidence"));
  for (const artifact of item.artifacts) {
    const actions = el("div", { class: "actions" });
    actions.append(link("Open committed plan", artifact.url)); body.append(actions);
    if (artifact.verified && typeof artifact.content === "string") {
      const details = el("details"); details.append(el("summary", {}, `Verified ${artifact.path}`), el("pre", {}, artifact.content)); body.append(details);
    } else body.append(notice(`Pinned evidence ${artifact.path} could not be verified.`));
  }
  renderState(body, item);
  if (item.receipt) renderReceipt(body, item);
  if (item.implementation) {
    body.append(el("h3", {}, "Next confirmed stage"));
    const next = el("div", { class: "actions" });
    next.append(link(`Open implementation PR #${item.implementation.number}`, item.implementation.url),
                link("Open implementation commit", item.implementation.commit_url)); body.append(next);
  }
}

function renderState(body, item) {
  if (item.state === "actionable" && item.review) {
    body.append(el("h3", {}, "Submit in GitHub"));
    body.append(notice("Submit a GitHub Comment review using the exact runner text.", "good"));
    const actions = el("div", { class: "actions", id: "review-actions" });
    const open = el("button", { type: "button", class: "primary", id: "open-review" }, "Open GitHub review ↗");
    const copy = el("button", { type: "button", id: "copy-approval" }, "Copy approval text");
    const reject = el("button", { type: "button", id: "copy-reject" }, "Copy changes-requested text");
    open.addEventListener("click", () => guarded("open")); copy.addEventListener("click", () => guarded("approve"));
    reject.addEventListener("click", () => guarded("reject")); actions.append(open, copy, reject); body.append(actions);
  } else if (item.state === "revision_changed") {
    const warning = notice("The previous receipt text has been withdrawn. Operator reconciliation or a trusted replacement is required.");
    warning.id = "revision-warning"; warning.tabIndex = -1; body.append(warning);
    const inspect = el("div", { class: "actions" });
    if (item.pr.current_commit_url) inspect.append(link("Open current exact head ↗", item.pr.current_commit_url));
    inspect.append(link("Open current PR for inspection ↗", item.pr.inspect_url)); body.append(inspect);
  } else if (item.state === "github_unavailable") {
    body.append(notice("GitHub is unavailable. Saved evidence is shown separately; review handoff is suspended."));
  } else if (item.state === "evidence_unavailable") {
    body.append(notice("Required pinned evidence could not be verified. Review handoff is suspended."));
  } else if (item.state === "verified_waiting") {
    body.append(notice("The runner saved an approval. Waiting for the operator to run host resume.", "good"));
  } else if (item.state === "implementation_review") {
    body.append(notice("The runner confirmed implementation review is next.", "good"));
  } else if (item.state === "implementation_next") {
    body.append(notice("The runner confirmed the plan gate advanced. Implementation is next.", "good"));
  } else if (item.state === "post_plan") {
    body.append(notice("The runner confirmed the plan gate advanced. Delivery is continuing from its saved stage.", "good"));
  } else if (item.state === "delivery_ready") {
    body.append(notice("Delivery confirmed the implementation is ready for repository review.", "good"));
  } else if (item.state === "runner_failed") {
    body.append(notice("The runner reported a failure. Review controls remain closed; the operator must inspect the host run."));
  } else if (item.state === "rejected") body.append(notice("A matching changes-requested receipt was saved. Review controls remain closed."));
  else if (item.state === "eligibility_unavailable") body.append(notice("Toolkit confirmed repository access but could not confirm reviewer eligibility. Review controls are suspended."));
  else body.append(notice(item.viewer.eligible ? "Review request is not currently actionable." : "An eligible plan reviewer must act."));
}

function renderReceipt(body, item) {
  const receipt = item.receipt; const section = el("section", { class: "receipt" });
  section.append(el("h3", {}, "Saved runner receipt"));
  const approvals = Array.isArray(receipt.approvers) ? receipt.approvers.length : 0;
  const minimum = receipt.minimum ?? 0;
  section.append(el("p", {}, receipt.approved ? `Review verified · ${approvals} of ${minimum} approvals` :
    (receipt.rejectors?.length ? "Changes requested" : approvals ? `${approvals} of ${minimum} approvals` : "No matching review found")));
  if (receipt.commit_id) section.append(el("p", { class: "sha" }, `Reviewed commit · ${receipt.commit_id}`));
  if (receipt.checked_at) section.append(el("p", { class: "muted" }, `Toolkit last checked · ${receipt.checked_at}`));
  if (receipt.enrichment === "verified") {
    section.append(el("p", {}, `GitHub review · @${receipt.reviewer} · ${receipt.submitted_at}`));
    if (receipt.url) section.append(link("Open GitHub review receipt ↗", receipt.url));
  } else section.append(el("p", { class: "muted" }, "Saved verdict retained; GitHub receipt metadata is unavailable or changed."));
  body.append(section);
}

async function guarded(kind) {
  const data = await load({ force: true, revision: state.revision });
  if (!data?.item?.review || data.revision !== state.revision) {
    $("revision-warning")?.focus(); announce("Review controls are no longer available"); return;
  }
  if (kind === "open") location.assign(data.item.review.url);
  else {
    const value = kind === "approve" ? data.item.review.approve : data.item.review.reject;
    await navigator.clipboard.writeText(value); announce(`${kind === "approve" ? "Approval" : "Changes-requested"} text copied`);
  }
}

function withdrawActions(message) {
  const actions = $("review-actions"); if (actions) actions.replaceChildren(el("span", { class: "muted" }, message));
}
function notice(text, kind = "") { return el("p", { class: `notice ${kind}`.trim() }, text); }
function link(text, href) { return el("a", { href, class: "button", target: "_blank", rel: "noopener noreferrer" }, text); }
function renderUnavailable() {
  $("feed-status").textContent = "Feed unavailable"; $("items").replaceChildren();
  $("detail-body").replaceChildren(el("h2", { id: "detail-title", tabindex: "-1" }, "Needs attention unavailable"),
    notice("The configured saved feed is unavailable or expired. Review controls are suspended."));
}
function renderSignIn() {
  $("feed-status").textContent = "Sign in required"; $("items").replaceChildren();
  const signIn = el("a", { href: "/auth/github", class: "button primary" }, "Sign in with GitHub");
  signIn.addEventListener("click", () => sessionStorage.removeItem("oauth-attempted"));
  $("detail-body").replaceChildren(el("h2", { id: "detail-title", tabindex: "-1" }, "Sign in required"),
    el("p", {}, "Use the configured GitHub account to open this private Delivery review."), signIn);
}
function renderAccessDenied() {
  $("feed-status").textContent = "Repository access denied"; $("items").replaceChildren();
  $("detail-body").replaceChildren(el("h2", { id: "detail-title", tabindex: "-1" }, "Repository access required"),
    notice("The signed-in GitHub account cannot access the configured private repository. No private item data was returned."));
}

$("refresh").addEventListener("click", () => load({ focus: isDetail() }));
$("mobile-back").addEventListener("click", (event) => {
  event.preventDefault();
  if (document.referrer.startsWith(location.origin) && history.length > 1) history.back();
  else location.assign("/");
});
window.addEventListener("popstate", () => { document.body.classList.toggle("detail-route", isDetail());
  if (!isDetail()) requestAnimationFrame(() => (state.originLink || $("inbox-title")).focus()); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ focus: false }); });
window.addEventListener("focus", () => { if (Date.now() >= state.expires) load(); });
load({ focus: isDetail() });
