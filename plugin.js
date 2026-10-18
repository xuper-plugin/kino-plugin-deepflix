// @ts-check
// Kino plugin: DeepFlix — movies and series in Latino Spanish, through the DeepFlix Stremio addon (mg.homelabx.qzz.io).
// The addon answers /stream/movie/<imdb>.json and /stream/series/<imdb>:<season>:<episode>.json with `/resolve/<token>` links
// that redirect (302) to the video file itself, so each one is a direct stream. It is Latino only. The catalog (home, search,
// browse, episodes) comes from TMDB through kino.tmdb, which needs no host.
//
// This is the same source the Latino plugin carries as one of its many (src/sources/deepflix.js there); this one stands alone.
//
// Declared host: mg.homelabx.qzz.io. `streamHosts: "any"` is for what the resolve link redirects to: a CDN of its own, over plain http.

// kino.meta and kino.tmdb exist from Kino 0.9.53; the guards are here for the SDK validator.
if (typeof kino.meta !== "function") throw kino.error("unavailable", "kino.meta not available");
if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "kino.tmdb not available");

const SITE = "https://mg.homelabx.qzz.io";
const TMDB_IMG = "https://image.tmdb.org/t/p/";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COPIES = 5;

// ---- i18n ----

const STRINGS = {
  es: {
    unavailable: "El servicio no está disponible en este momento.",
    noStreams: "No se encontraron fuentes para este título.",
    noMeta: "No se encontró información de este título.",
    trendingMovies: "Películas populares",
    trendingSeries: "Series populares",
    nowPlaying: "En cines ahora",
    upcoming: "Próximos estrenos",
    topMovies: "Películas mejor valoradas",
    onTheAir: "Series en emisión",
    topSeries: "Series mejor valoradas",
    kids: "Para los niños",
    docs: "Documentales",
    gAction: "Acción",
    gComedy: "Comedia",
    gSciFi: "Ciencia ficción",
    gHorror: "Terror",
    gDrama: "Drama",
    cacheCleared: "Caché de IDs vaciada.",
    latino: "Latino",
  },
  en: {
    unavailable: "The service is not available right now.",
    noStreams: "No streams found for this title.",
    noMeta: "No metadata found for this title.",
    trendingMovies: "Trending movies",
    trendingSeries: "Trending series",
    nowPlaying: "In theaters now",
    upcoming: "Coming soon",
    topMovies: "Top rated movies",
    onTheAir: "Series on the air",
    topSeries: "Top rated series",
    kids: "For kids",
    docs: "Documentaries",
    gAction: "Action",
    gComedy: "Comedy",
    gSciFi: "Science fiction",
    gHorror: "Horror",
    gDrama: "Drama",
    cacheCleared: "ID cache cleared.",
    latino: "Latino",
  },
};

function t(key) {
  const lang = String(kino.lang || "es").startsWith("en") ? "en" : "es";
  return (STRINGS[lang] || STRINGS.es)[key] || key;
}

// ---- DeepFlix API ----

// type: "movie" | "series"; id: "tt1234567" or "tt1234567:1:5" (an episode)
async function fetchStreams(type, id) {
  const r = await kino.fetch(`${SITE}/stream/${type}/${id}.json`, { timeoutMs: 45000 });
  if (!r.ok) throw kino.error("unavailable", `DeepFlix answered ${r.status} for ${type}/${id}`, { userMessage: t("unavailable") });
  let body;
  try {
    body = r.json();
  } catch {
    throw kino.error("unavailable", "DeepFlix returned invalid JSON", { userMessage: t("unavailable") });
  }
  return Array.isArray(body?.streams) ? body.streams : [];
}

/** The addon's own resolve links, once each: whatever else a response carries is not ours to play. */
function resolveLinks(streams) {
  const seen = new Set();
  const out = [];
  for (const s of streams) {
    const url = s && s.url;
    if (typeof url !== "string" || !url.startsWith(SITE + "/resolve/") || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, quality: /(\d{3,4})p/.exec(String(s.description || ""))?.[1] || "" });
  }
  return out;
}

// ---- TMDB catalog helpers ----

// TMDB's genre ids as names Kino knows (movie and TV ids). The Home files every title by its genres, one row per genre across
// all plugins, so a title that carries none lands in the bare "Películas" / "Series" rows: that is why a Home with only the
// row's own `genre` showed two rows. Kids, news and talk are types for Kino, not genres: the "kids" row covers them.
const TMDB_GENRES = {
  28: "Acción", 12: "Aventura", 16: "Animación", 35: "Comedia", 80: "Crimen", 99: "Documentales", 18: "Drama", 10751: "Familia",
  14: "Fantasía", 36: "Historia", 27: "Terror", 9648: "Misterio", 10749: "Romance", 878: "Ciencia ficción", 53: "Suspenso",
  10752: "Bélica", 37: "Western", 10759: "Acción", 10765: "Ciencia ficción", 10766: "Drama", 10764: "Reality", 10768: "Bélica",
};

/** The Kino genre names of a TMDB result (`genre_ids`), without repeats, at most 5. */
function genresOf(raw) {
  const names = new Set();
  for (const id of Array.isArray(raw.genre_ids) ? raw.genre_ids : []) if (TMDB_GENRES[id]) names.add(TMDB_GENRES[id]);
  return [...names].slice(0, 5);
}

function itemFromTmdb(raw, kind) {
  const isMovie = kind === "movie";
  const tmdbId = raw.id;
  return {
    id: (isMovie ? "m" : "s") + tmdbId,
    ref: (isMovie ? "m:" : "s:") + tmdbId,
    title: String(raw.title || raw.name || ""),
    kind: isMovie ? "movie" : "series",
    year: (raw.release_date || raw.first_air_date || "").slice(0, 4) || undefined,
    poster: raw.poster_path ? TMDB_IMG + "w500" + raw.poster_path : undefined,
    backdrop: raw.backdrop_path ? TMDB_IMG + "w1280" + raw.backdrop_path : undefined,
    overview: raw.overview || undefined,
    rating: raw.vote_average > 0 ? Math.round(raw.vote_average * 10) / 10 : undefined,
    ids: { tmdb: tmdbId },
    genres: genresOf(raw).length ? genresOf(raw) : undefined,
  };
}

// A TMDB id → an IMDB id, cached 30 days
async function imdbFor(tmdbId, type) {
  const key = "imdb:" + type + ":" + tmdbId;
  const hit = kino.storage.get(key);
  if (hit) return hit;
  const meta = await kino.meta({ type, ids: { tmdb: Number(tmdbId) } });
  const imdb = meta?.ids?.imdb ?? null;
  if (imdb) kino.storage.set(key, imdb, { ttlMs: 30 * DAY_MS });
  return imdb;
}

const titlesOf = (query) => [query.q, query.originalTitle, ...(query.altTitles || [])].filter(Boolean);

// ---- home ----

/**
 * The Home rows, in order. `genre` is one of Kino's ten ids (it lines the rows up with other plugins' in the Categorías tab) and
 * `ref` makes the row browsable ("Ver más"). `path` is the TMDB list behind it; `params` narrow it (a genre of /discover).
 */
const HOME_ROWS = [
  { id: "trending-movies", title: "trendingMovies", genre: "peliculas", ref: "trend:movie", kind: "movie", path: "/trending/movie/week" },
  { id: "now-playing", title: "nowPlaying", genre: "peliculas", ref: "list:movie:now_playing", kind: "movie", path: "/movie/now_playing" },
  { id: "upcoming", title: "upcoming", genre: "peliculas", ref: "list:movie:upcoming", kind: "movie", path: "/movie/upcoming" },
  { id: "top-movies", title: "topMovies", genre: "peliculas", ref: "list:movie:top_rated", kind: "movie", path: "/movie/top_rated" },
  { id: "trending-series", title: "trendingSeries", genre: "series", ref: "trend:tv", kind: "tv", path: "/trending/tv/week" },
  { id: "on-the-air", title: "onTheAir", genre: "series", ref: "list:tv:on_the_air", kind: "tv", path: "/tv/on_the_air" },
  { id: "top-series", title: "topSeries", genre: "series", ref: "list:tv:top_rated", kind: "tv", path: "/tv/top_rated" },
  { id: "g-action", title: "gAction", genre: "peliculas", ref: "genre:movie:28", kind: "movie", path: "/discover/movie", params: { with_genres: 28 } },
  { id: "g-comedy", title: "gComedy", genre: "peliculas", ref: "genre:movie:35", kind: "movie", path: "/discover/movie", params: { with_genres: 35 } },
  { id: "g-scifi", title: "gSciFi", genre: "peliculas", ref: "genre:movie:878", kind: "movie", path: "/discover/movie", params: { with_genres: 878 } },
  { id: "g-horror", title: "gHorror", genre: "peliculas", ref: "genre:movie:27", kind: "movie", path: "/discover/movie", params: { with_genres: 27 } },
  { id: "g-drama", title: "gDrama", genre: "peliculas", ref: "genre:movie:18", kind: "movie", path: "/discover/movie", params: { with_genres: 18 } },
  { id: "kids", title: "kids", genre: "infantil", ref: "genre:movie:10751", kind: "movie", path: "/discover/movie", params: { with_genres: 10751 } },
  { id: "docs", title: "docs", genre: "documentales", ref: "genre:movie:99", kind: "movie", path: "/discover/movie", params: { with_genres: 99 } },
];

// A discover list sorted by popularity is full of titles nobody has voted on: ask for some votes.
const DISCOVER = { sort_by: "popularity.desc", "vote_count.gte": 200 };

async function homeRow(row) {
  const res = await kino.tmdb(row.path, { ...(row.path.startsWith("/discover") ? DISCOVER : {}), ...(row.params || {}) });
  // a row of posters: what has none looks broken
  const items = (res?.results || []).filter((r) => r.poster_path).slice(0, 20).map((r) => itemFromTmdb(r, row.kind));
  return items.length ? { id: row.id, title: t(row.title), genre: row.genre, ref: row.ref, items } : null;
}

export async function home() {
  // Every row on its own: one that fails or comes back empty is left out, the rest of the Home is still shown.
  const settled = await Promise.allSettled(HOME_ROWS.map(homeRow));
  const rows = settled.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
  if (!rows.length) throw kino.error("unavailable", "no home row could be loaded", { userMessage: t("unavailable") });
  return rows;
}

// ---- search ----

export async function search(query) {
  if (!String(query.q || "").trim()) return [];
  const type = query.type;

  if (type === "series") {
    const res = await kino.tmdb("/search/tv", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "tv")), titlesOf(query));
  }
  if (type === "movie") {
    const res = await kino.tmdb("/search/movie", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "movie")), titlesOf(query));
  }

  // "any", and the kinds this plugin has nothing for (anime, music, podcast): both catalogs, ranked by how they match
  const [movies, tv] = await Promise.all([
    kino.tmdb("/search/movie", { query: query.q }),
    kino.tmdb("/search/tv", { query: query.q }),
  ]);
  const all = [
    ...(movies?.results || []).map((r) => itemFromTmdb(r, "movie")),
    ...(tv?.results || []).map((r) => itemFromTmdb(r, "tv")),
  ];
  return kino.rank.sortBySimilarity(all, titlesOf(query));
}

// ---- browse ----

export async function browse(ref, cursor) {
  const page = cursor ? Number(cursor) : 1;
  let path, params = { page }, kind;

  const parts = String(ref).split(":");
  if (parts[0] === "trend" && (parts[1] === "movie" || parts[1] === "tv")) {
    kind = parts[1];
    path = `/trending/${kind}/week`;
  } else if (parts[0] === "list" && (parts[1] === "movie" || parts[1] === "tv") && /^[a-z_]+$/.test(parts[2] || "")) {
    kind = parts[1];
    path = `/${kind}/${parts[2]}`;
  } else if (parts[0] === "popular" && (parts[1] === "movie" || parts[1] === "tv")) {
    kind = parts[1];
    path = `/${kind}/popular`;
  } else if (parts[0] === "genre" && (parts[1] === "movie" || parts[1] === "tv") && /^\d+$/.test(parts[2] || "")) {
    kind = parts[1];
    path = `/discover/${kind}`;
    params = { ...DISCOVER, with_genres: parts[2], page };
  } else {
    return { items: [] };
  }

  const res = await kino.tmdb(path, params);
  const items = (res?.results || []).filter((r) => r.poster_path).map((r) => itemFromTmdb(r, kind));
  const next = res?.page < res?.total_pages ? String(page + 1) : undefined;
  return { items, next };
}

// ---- categories ----

export async function categories() {
  const [mg, tg] = await Promise.all([kino.tmdb("/genre/movie/list"), kino.tmdb("/genre/tv/list")]);
  const cats = [];
  for (const g of (mg?.genres || []).slice(0, 12)) cats.push({ id: "gm" + g.id, title: g.name, ref: "genre:movie:" + g.id });
  for (const g of (tg?.genres || []).slice(0, 8)) cats.push({ id: "gt" + g.id, title: g.name + " (series)", ref: "genre:tv:" + g.id });
  return cats.slice(0, 24);
}

// ---- episodes ----

export async function episodes(ref) {
  const tmdbId = ref.startsWith("s:") ? ref.slice(2) : ref;
  const meta = await kino.meta({ type: "series", ids: { tmdb: Number(tmdbId) } });
  if (!meta) throw kino.error("not_found", "series not found: tmdb " + tmdbId, { userMessage: t("noMeta") });

  const imdbId = meta.ids?.imdb;
  if (!imdbId) throw kino.error("not_found", "no IMDB id for series tmdb:" + tmdbId, { userMessage: t("noMeta") });
  kino.storage.set("imdb:series:" + tmdbId, imdbId, { ttlMs: 30 * DAY_MS });

  return {
    series: {
      title: meta.title,
      poster: meta.poster,
      backdrop: meta.backdrop,
      overview: meta.overview,
      genres: meta.genres,
      year: meta.year,
      ids: meta.ids,
      runtimeMinutes: meta.runtimeMinutes,
    },
    episodes: (meta.episodes || []).map((ep) => ({
      season: ep.season,
      number: ep.number,
      // the IMDB id rides in the ref so resolve() does not need kino.meta again
      ref: "ep:" + imdbId + ":" + ep.season + ":" + ep.number,
      title: ep.title,
      still: ep.still,
      overview: ep.overview,
      airDate: ep.airDate,
    })),
  };
}

// ---- resolve ----

export async function resolve(ref) {
  let type, id;
  if (ref.startsWith("ep:")) {
    const [, imdbId, season, episode] = ref.split(":");
    type = "series";
    id = imdbId + ":" + season + ":" + episode;
  } else if (ref.startsWith("m:")) {
    const tmdbId = ref.slice(2);
    const imdbId = await imdbFor(tmdbId, "movie");
    if (!imdbId) throw kino.error("not_found", "no IMDB id for movie tmdb:" + tmdbId, { userMessage: t("noMeta") });
    type = "movie";
    id = imdbId;
  } else {
    throw kino.error("not_found", "unknown ref: " + ref.slice(0, 40));
  }

  const links = resolveLinks(await fetchStreams(type, id));
  if (!links.length) throw kino.error("not_found", "no playable streams for " + type + "/" + id, { userMessage: t("noStreams") });

  // The link redirects to the file: the site is its Referer. The first one plays, the next ones are copies.
  const headers = { Referer: SITE + "/" };
  const label = (l) => [t("latino"), l.quality ? l.quality + "p" : ""].filter(Boolean).join(" · ");
  const [main, ...rest] = links;
  const alternatives = rest.slice(0, MAX_COPIES).map((l) => ({ url: l.url, label: label(l), headers }));
  return { url: main.url, label: label(main), headers, ...(alternatives.length ? { alternatives } : {}) };
}

// ---- settings actions ----

export async function action(key) {
  if (key === "clearCache") {
    for (const k of kino.storage.keys()) {
      if (k.startsWith("imdb:")) kino.storage.remove(k);
    }
    return { message: t("cacheCleared") };
  }
}
