// ── Validate and promote pending comments ───────────────────────────────────
//
// Runs from .github/workflows/validate-and-promote.yml on every push that
// touches pending/. Each file under pending/ is one comment submission
// written by btsbootcamp's js/comments.js (createComment()), using a token
// scoped only to THIS repo (campcomments) — it has no access to
// bestofbootcamp or the site code. That's the entire reason this repo
// exists as its own staging inbox: a leaked client token can only spam this
// repo's pending/ queue, never write directly to real data.
//
// campcomments is a peer of btsbootcamp's other staging inbox, burnthestage
// (which stages user signups) — both are "nothing valuable inside" repos
// that funnel into the same validated destination, bestofbootcamp. Comments
// don't route through burnthestage at all, so nothing here can ever affect
// the signup pipeline.
//
// What this does, in order:
//   1. Read every pending/*.json file from the checked-out working copy
//   2. Validate each one (well-formed JSON, matches the expected shape,
//      username corresponds to a real profile in bestofbootcamp)
//   3. Batch all valid entries into ONE commit to bestofbootcamp/data/comments.json
//   4. Delete every processed file locally — valid or not — so the workflow's
//      own "clean up pending files" step (in the YAML, not here) commits
//      their removal from campcomments
//
// Full rationale for the staging/destination split is in
// ARCHITECTURE_DECISIONS.md in the main btsbootcamp repo.

const fs = require("fs");
const path = require("path");

const DATA_OWNER = "diyamaxxing";
const DATA_REPO = "bestofbootcamp";
const PENDING_DIR = "pending";

const MAX_COMMENT_LENGTH = 2000;

// Structural validation only — checks shape, not whether the content is
// "good" (e.g. a well-formed but spammy comment still passes). Catching
// that would need extra heuristics (rate limits, etc.), not implemented here.
// Must stay in sync with the client-side checks in btsbootcamp's
// js/comments.js — if the client accepts something this rejects, that
// submission silently vanishes from pending/ without ever reaching
// bestofbootcamp.
function validate(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.video_id !== "string" || !entry.video_id.trim()) return "missing video_id";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.video_id.trim())) return "invalid video_id format";
  if (typeof entry.username !== "string" || !entry.username.trim()) return "missing username";
  if (typeof entry.comment !== "string" || !entry.comment.trim()) return "missing comment";
  if (entry.comment.trim().length > MAX_COMMENT_LENGTH) return "comment too long";
  // V1 has no reply UI yet — reject anything claiming to be a reply rather
  // than silently dropping the parent link, so a client-side bug surfaces
  // as a rejected submission instead of a orphaned thread later.
  if (entry.parent_comment_id !== null && entry.parent_comment_id !== undefined) {
    return "replies not supported yet";
  }
  return null;
}

// Thin wrapper around the GitHub Contents API, always targeting
// bestofbootcamp. Every call here uses BOB_TOKEN — the credential that can
// ONLY write to that one repo, never campcomments or the site code.
async function githubRequest(apiPath, token, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${DATA_OWNER}/${DATA_REPO}/${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} on ${apiPath}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  const bobToken = process.env.BOB_TOKEN;
  if (!bobToken) throw new Error("BOB_TOKEN not set");

  const pendingDirPath = path.join(process.cwd(), PENDING_DIR);
  if (!fs.existsSync(pendingDirPath)) {
    console.log("No pending directory, nothing to do.");
    return;
  }

  const files = fs.readdirSync(pendingDirPath).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No pending submissions.");
    return;
  }

  // Real profiles live in bestofbootcamp, not this repo — a comment can
  // only be validated by checking against the live, promoted user list.
  // Fetched once per run, same as the comments file below.
  const usersFile = await githubRequest("contents/data/users.json?ref=main", bobToken);
  const users = JSON.parse(Buffer.from(usersFile.content, "base64").toString("utf-8"));
  const knownUsernames = new Set(users.map((u) => u.username.toLowerCase()));

  const commentsFile = await githubRequest("contents/data/comments.json?ref=main", bobToken);
  const comments = JSON.parse(Buffer.from(commentsFile.content, "base64").toString("utf-8"));

  const accepted = [];
  const now = new Date().toISOString();

  files.forEach((file, i) => {
    const filePath = path.join(pendingDirPath, file);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      console.log(`Rejected ${file}: invalid JSON`);
      return;
    }

    const error = validate(entry);
    if (error) {
      console.log(`Rejected ${file}: ${error}`);
      return;
    }

    const cleanUsername = entry.username.trim();
    if (!knownUsernames.has(cleanUsername.toLowerCase())) {
      console.log(`Rejected ${file}: no profile for username "${cleanUsername}"`);
      return;
    }

    // comment_id and posted_at are assigned here, never trusted from the
    // client — same reasoning as createdAt in the signup promote.js.
    accepted.push({
      comment_id: `${entry.video_id.trim()}-${Date.now()}-${i}`,
      parent_comment_id: null,
      video_id: entry.video_id.trim(),
      username: cleanUsername,
      comment: entry.comment.trim(),
      posted_at: now,
    });
  });

  // One commit for the whole batch, not one per comment — same reasoning
  // as the signup pipeline: fewer API calls, one readable commit per run.
  if (accepted.length > 0) {
    const updatedComments = comments.concat(accepted);
    const updatedContent = Buffer.from(JSON.stringify(updatedComments, null, 2) + "\n", "utf-8").toString("base64");
    await githubRequest("contents/data/comments.json", bobToken, {
      method: "PUT",
      body: JSON.stringify({
        message: `Promote ${accepted.length} new comment(s) on: ${[...new Set(accepted.map((c) => c.video_id))].join(", ")}`,
        content: updatedContent,
        sha: commentsFile.sha,
        branch: "main",
      }),
    });
    console.log(`Promoted ${accepted.length} comment(s).`);
  } else {
    console.log("No valid submissions to promote.");
  }

  // Delete every processed file locally — accepted AND rejected — so
  // nothing gets reprocessed on the next run. This only touches the
  // checkout on disk; the workflow YAML's next step is what actually
  // commits the removal back to campcomments.
  files.forEach((file) => fs.unlinkSync(path.join(pendingDirPath, file)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
