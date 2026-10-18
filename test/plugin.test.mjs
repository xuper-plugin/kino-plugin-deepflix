// node --test test/plugin.test.mjs
// Offline: a fake DeepFlix and a stub of the `kino` object. Checks what the plugin asks and what it hands to Kino.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateManifest } from "../sdk/contract.mjs";

const calls = [];
let config = {};
let respond = () => ({ streams: [] });
const tmdbCalls = [];
let tmdbImpl = async () => ({ results: [] });
let metaImpl = async () => null;
globalThis.kino = {
  lang: "es",
  config: { get: (k) => config[k] },
  fetch: async (url) => { calls.push(url); const body = respond(url); return { ok: true, status: 200, json: () => body }; },
  storage: { get: () => null, set() {}, keys: () => [], remove() {} },
  tmdb: async (path, params) => { tmdbCalls.push({ path, params }); return tmdbImpl(path, params); },
  meta: (q) => metaImpl(q), rank: {},
  error: (code, message, opts = {}) => Object.assign(new Error(message), { code, ...opts }),
};
const plugin = await import("../plugin.js");

beforeEach(() => { calls.length = 0; tmdbCalls.length = 0; config = {}; respond = () => ({ streams: [] }); tmdbImpl = async () => ({ results: [] }); metaImpl = async () => null; });

const SITE = "https://mg.homelabx.qzz.io";
const link = (n) => `${SITE}/resolve/token${n}`;
/** A DeepFlix stream: `description` is lines like "🎬 Matrix\n🎥 720p\n🗣️ 🇲🇽 / 🇪🇸? / 🇺🇸?", `url` the resolve link. */
const stream = (n, { q = "720p", url = link(n) } = {}) => ({ name: "DeepFlix", description: `🎬 Matrix\n🎥 ${q}\n🗣️ 🇲🇽 / 🇪🇸? / 🇺🇸?\n💻 Web Link\n🔍 DeepFlix`, url });

const manifest = JSON.parse(readFileSync(new URL("../kino-plugin.json", import.meta.url), "utf8"));

test("the manifest is valid for Kino, names only DeepFlix's host and asks for no resolver app", () => {
  const out = validateManifest(readFileSync(new URL("../kino-plugin.json", import.meta.url), "utf8"));
  assert.ok(!out.errors?.length, JSON.stringify(out.errors));
  assert.deepEqual(manifest.hosts, ["mg.homelabx.qzz.io"]);
  assert.equal(manifest.streamHosts, "any");
  assert.ok(!manifest.capabilities.includes("externalResolve") && !manifest.externalResolver);
});

test("an episode asks series/<imdb>:<s>:<e> and plays the resolve link with the site as Referer", async () => {
  respond = () => ({ streams: [stream(1, { q: "1080p" })] });
  const a = await plugin.resolve("ep:tt0903747:2:5");
  assert.equal(calls[0], SITE + "/stream/series/tt0903747:2:5.json");
  assert.equal(a.url, link(1));
  assert.deepEqual(a.headers, { Referer: SITE + "/" });
  assert.equal(a.label, "Latino · 1080p");
  assert.equal(a.alternatives, undefined);
});

test("a movie asks movie/<imdb> with the IMDB id of its TMDB id", async () => {
  metaImpl = async (q) => (q.ids.tmdb === 603 ? { ids: { imdb: "tt0133093" } } : null);
  respond = () => ({ streams: [stream(1)] });
  const a = await plugin.resolve("m:603");
  assert.equal(calls[0], SITE + "/stream/movie/tt0133093.json");
  assert.equal(a.url, link(1));
  await assert.rejects(() => plugin.resolve("m:999"), (e) => e.code === "not_found" && e.userMessage === "No se encontró información de este título.");
});

test("only the addon's own resolve links count, once each; the next ones are copies", async () => {
  respond = () => ({ streams: [
    stream(1), stream(1),
    { name: "x", url: "https://evil.example.com/resolve/abc" },
    { name: "y", url: SITE + "/other/abc" },
    { name: "z" },
    stream(2, { q: "480p" }), stream(3),
  ] });
  const a = await plugin.resolve("ep:tt1:1:1");
  assert.equal(a.url, link(1));
  assert.deepEqual(a.alternatives.map((x) => x.url), [link(2), link(3)]);
  assert.deepEqual(a.alternatives.map((x) => x.label), ["Latino · 480p", "Latino · 720p"]);
  assert.ok(a.alternatives.every((x) => x.headers.Referer === SITE + "/"));
});

test("at most five copies besides the main one", async () => {
  respond = () => ({ streams: Array.from({ length: 12 }, (_, i) => stream(i + 1)) });
  assert.equal((await plugin.resolve("ep:tt1:1:1")).alternatives.length, 5);
});

test("nothing found, or a failing addon, gives a readable error", async () => {
  respond = () => ({ streams: [] });
  await assert.rejects(() => plugin.resolve("ep:tt1:1:1"), (e) => e.code === "not_found" && e.userMessage === "No se encontraron fuentes para este título.");
  const before = globalThis.kino.fetch;
  globalThis.kino.fetch = async () => ({ ok: false, status: 502, json: () => ({}) });
  try { await assert.rejects(() => plugin.resolve("ep:tt1:1:1"), (e) => e.code === "unavailable" && e.userMessage === "El servicio no está disponible en este momento."); }
  finally { globalThis.kino.fetch = before; }
  await assert.rejects(() => plugin.resolve("nonsense"), (e) => e.code === "not_found");
});

test("the cache action empties only the IMDB ids", async () => {
  const removed = [];
  const before = globalThis.kino.storage;
  globalThis.kino.storage = { get: () => null, set() {}, keys: () => ["imdb:movie:1", "other", "imdb:series:2"], remove: (k) => removed.push(k) };
  try { assert.equal((await plugin.action("clearCache")).message, "Caché de IDs vaciada."); } finally { globalThis.kino.storage = before; }
  assert.deepEqual(removed, ["imdb:movie:1", "imdb:series:2"]);
});

// ---- home and browse ----

const GENRES = ["peliculas", "series", "anime", "infantil", "documentales", "deportes", "noticias", "musica", "entretenimiento", "otros"];
const titles = (n, withPoster = true) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, title: "T" + i, name: "T" + i, release_date: "2024-01-01", ...(withPoster ? { poster_path: "/p" + i + ".jpg" } : {}) }));

test("home has many rows, each with a genre Kino knows, a ref to browse and at most 20 titles", async () => {
  tmdbImpl = async () => ({ results: titles(40), page: 1, total_pages: 5 });
  const rows = await plugin.home();
  assert.ok(rows.length >= 10 && rows.length <= 20, "rows: " + rows.length);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  for (const r of rows) {
    assert.ok(GENRES.includes(r.genre), r.id + " genre " + r.genre);
    assert.ok(r.ref && r.title && r.items.length > 0 && r.items.length <= 20, r.id);
    assert.ok(r.items.every((i) => i.poster && i.ref && i.kind));
  }
  assert.ok(rows.some((r) => r.genre === "series") && rows.some((r) => r.genre === "infantil") && rows.some((r) => r.genre === "documentales"));
  assert.ok(tmdbCalls.length <= 20, "one TMDB call per row, within Kino's 20 per 10 s: " + tmdbCalls.length);
});

test("every title carries its genres, so the Home can file it in a row per genre (not only 'Películas' and 'Series')", async () => {
  tmdbImpl = async () => ({ results: [{ id: 1, title: "A", poster_path: "/a.jpg", genre_ids: [28, 878, 12, 99999], release_date: "2024-01-01" }, { id: 2, title: "B", poster_path: "/b.jpg", genre_ids: [10759, 10765, 18] }, { id: 3, title: "C", poster_path: "/c.jpg" }] });
  const items = (await plugin.home())[0].items;
  assert.deepEqual(items[0].genres, ["Acción", "Ciencia ficción", "Aventura"]);
  assert.deepEqual(items[1].genres, ["Acción", "Ciencia ficción", "Drama"]);
  assert.equal(items[2].genres, undefined);
  assert.ok((await plugin.browse("list:movie:top_rated", null)).items[0].genres.length > 0);
});

test("the genre rows are discover lists with some votes behind them", async () => {
  tmdbImpl = async () => ({ results: titles(5) });
  await plugin.home();
  const action = tmdbCalls.find((c) => c.params?.with_genres === 28);
  assert.equal(action.path, "/discover/movie");
  assert.equal(action.params["vote_count.gte"], 200);
});

test("a row that fails or has no posters is left out, the others are still shown", async () => {
  tmdbImpl = async (path) => {
    if (path === "/movie/upcoming") throw new Error("boom");
    if (path === "/movie/top_rated") return { results: titles(5, false) };
    return { results: titles(5) };
  };
  const rows = await plugin.home();
  assert.ok(!rows.some((r) => r.id === "upcoming" || r.id === "top-movies"));
  assert.ok(rows.length >= 10);
});

test("when no row can be loaded the person gets a readable error", async () => {
  tmdbImpl = async () => { throw new Error("down"); };
  await assert.rejects(() => plugin.home(), (e) => e.code === "unavailable" && e.userMessage === "El servicio no está disponible en este momento.");
});

test("rows are named in the person's language", async () => {
  tmdbImpl = async () => ({ results: titles(3) });
  globalThis.kino.lang = "en";
  try { assert.equal((await plugin.home())[0].title, "Trending movies"); } finally { globalThis.kino.lang = "es"; }
});

test("every home row's ref opens its own list in Ver más, page after page", async () => {
  tmdbImpl = async (path, params) => ({ results: titles(30), page: params.page, total_pages: 3 });
  const rows = await plugin.home();
  for (const row of rows) {
    tmdbCalls.length = 0;
    const first = await plugin.browse(row.ref, null);
    assert.ok(first.items.length > 0, row.ref);
    assert.equal(first.next, "2", row.ref);
    assert.equal(tmdbCalls[0].path, HOME_PATHS[row.id], row.ref + " -> " + tmdbCalls[0].path);
    const last = await plugin.browse(row.ref, "3");
    assert.equal(last.next, undefined);
  }
  assert.deepEqual(await plugin.browse("nonsense", null), { items: [] });
  assert.deepEqual(await plugin.browse("list:movie:../account", null), { items: [] });
});

const HOME_PATHS = {
  "trending-movies": "/trending/movie/week", "now-playing": "/movie/now_playing", upcoming: "/movie/upcoming", "top-movies": "/movie/top_rated",
  "trending-series": "/trending/tv/week", "on-the-air": "/tv/on_the_air", "top-series": "/tv/top_rated",
  "g-action": "/discover/movie", "g-comedy": "/discover/movie", "g-scifi": "/discover/movie", "g-horror": "/discover/movie",
  "g-drama": "/discover/movie", kids: "/discover/movie", docs: "/discover/movie", anime: "/discover/tv",
};
