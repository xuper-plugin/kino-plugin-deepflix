// node --test test/home-budget.test.mjs
// A Home whose later batches are slow (Kino's TMDB limit spent) answers with the rows that loaded instead of running over Kino's 20 s.
import { test } from "node:test";
import assert from "node:assert/strict";

let clock = 0;
let tmdbImpl = async () => ({ results: [] });
globalThis.kino = {
  lang: "es",
  config: { get: () => undefined },
  fetch: async () => ({ ok: true, status: 200, json: () => ({}) }),
  storage: { get: () => null, set() {}, keys: () => [], remove() {} },
  tmdb: (p, q) => tmdbImpl(p, q),
  sleep: async (ms) => { clock += ms; },
  log() {}, meta: async () => null, rank: {},
  error: (code, message, opts = {}) => Object.assign(new Error(message), { code, ...opts }),
};
const realNow = Date.now;
const plugin = await import("../plugin.js");
const results = Array.from({ length: 5 }, (_, i) => ({ id: 1 + i, title: "T" + i, name: "T" + i, release_date: "2024-01-01", poster_path: "/p.jpg" }));

test("the plugin asks Kino to drop the requests a call leaves running", () => {
  assert.equal(globalThis.__kinoDropPendingFetches, true);
});

test("slow later batches do not sink the Home: the first rows are shown and no new batch starts past the budget", async () => {
  clock = 0;
  Date.now = () => 1e12 + clock;
  let calls = 0;
  tmdbImpl = async () => {
    calls++;
    if (calls <= 5) return { results };
    await kino.sleep(9000); // a spent limit: every row waits and asks again
    return { results };
  };
  try {
    const rows = await plugin.home();
    assert.ok(rows.length >= 5, "rows: " + rows.length);
    assert.ok(rows.length < 15, "the slow batches were cut: " + rows.length);
    assert.ok(calls < 15, "no batch started after the budget: " + calls);
  } finally { Date.now = realNow; }
});

test("when nothing loads in time the Home says it is unavailable", async () => {
  clock = 0;
  Date.now = () => 1e12 + clock;
  tmdbImpl = async () => { await kino.sleep(20000); throw Object.assign(new Error("x"), { code: "failed" }); };
  try {
    await assert.rejects(() => plugin.home(), (e) => e.code === "unavailable");
  } finally { Date.now = realNow; }
});
