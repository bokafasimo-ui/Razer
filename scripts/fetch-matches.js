// fetch-matches.js — GitHub Actions script
// Fetches best match from API-Football and caches it in Supabase

const https = require("https");

const API_KEY      = process.env.FOOTBALL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables. Check GitHub Secrets:");
  console.error("  FOOTBALL_API_KEY:", !!API_KEY);
  console.error("  SUPABASE_URL:",     !!SUPABASE_URL);
  console.error("  SUPABASE_SERVICE_KEY:", !!SUPABASE_KEY);
  process.exit(1);
}

// ── Tournament priority tiers ──────────────────────────────────
const TIERS = [
  // TIER 1 — Absolute priority
  { tier:1, leagueId:1,   name:"🌍 MUNDIAL FIFA",       label:"WORLD CUP"       },
  { tier:1, leagueId:9,   name:"🌎 COPA AMERICA",        label:"COPA AMERICA"    },
  { tier:1, leagueId:2,   name:"🏆 CHAMPIONS LEAGUE",    label:"UCL"             },
  { tier:1, leagueId:4,   name:"🌍 UEFA EURO",           label:"EURO"            },
  // TIER 2 — Core European leagues
  { tier:2, leagueId:140, name:"🇪🇸 LA LIGA",            label:"LA LIGA"         },
  { tier:2, leagueId:39,  name:"🏴 PREMIER LEAGUE",      label:"PREMIER"         },
  { tier:2, leagueId:135, name:"🇮🇹 SERIE A",            label:"SERIE A"         },
  { tier:2, leagueId:78,  name:"🇩🇪 BUNDESLIGA",         label:"BUNDESLIGA"      },
  { tier:2, leagueId:61,  name:"🇫🇷 LIGUE 1",            label:"LIGUE 1"         },
  // TIER 3 — LATAM knockouts only
  { tier:3, leagueId:13,  name:"🌎 LIBERTADORES",        label:"LIBERTADORES"    },
  { tier:3, leagueId:11,  name:"🌎 SUDAMERICANA",        label:"SUDAMERICANA"    },
];

const BIG_LATAM = [
  "Boca Juniors","River Plate","Flamengo","Palmeiras",
  "Atletico Mineiro","Fluminense","Nacional","Peñarol",
  "Colo-Colo","Liga de Quito","Independiente"
];

// ── Helper: HTTP GET with promise ──────────────────────────────
function httpGet(url, headers) {
  return new Promise(function(resolve, reject) {
    var opts = require("url").parse(url);
    opts.headers = headers;
    https.get(opts, function(res) {
      var body = "";
      res.on("data", function(d){ body += d; });
      res.on("end", function(){
        try { resolve(JSON.parse(body)); }
        catch(e){ reject(new Error("JSON parse error: " + e.message)); }
      });
    }).on("error", reject);
  });
}

function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }

function todayStr(){
  return new Date().toISOString().slice(0,10);
}
function tomorrowStr(){
  var d = new Date(); d.setDate(d.getDate()+1);
  return d.toISOString().slice(0,10);
}

// ── Fetch fixtures for one league ─────────────────────────────
async function fetchFixtures(leagueId, date1, date2) {
  try {
    var url = "https://v3.football.api-sports.io/fixtures" +
              "?league=" + leagueId +
              "&from=" + date1 +
              "&to=" + date2 +
              "&status=NS-1H-HT-2H";
    var json = await httpGet(url, {
      "x-apisports-key": API_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io"
    });
    if (json.errors && Object.keys(json.errors).length) {
      console.warn("API error for league " + leagueId + ":", JSON.stringify(json.errors));
      return [];
    }
    return Array.isArray(json.response) ? json.response : [];
  } catch(e) {
    console.warn("Could not fetch league " + leagueId + ":", e.message);
    return [];
  }
}

// ── Score match importance ─────────────────────────────────────
function importanceScore(fixture, tierInfo) {
  var score = (4 - tierInfo.tier) * 1000;
  var round = ((fixture.league && fixture.league.round) || "").toLowerCase();

  if (tierInfo.leagueId === 1 || tierInfo.leagueId === 9) {
    if (round.indexOf("final") >= 0 && round.indexOf("semi") < 0 &&
        round.indexOf("quarter") < 0) score += 500;
    else if (round.indexOf("semi") >= 0)    score += 400;
    else if (round.indexOf("quarter") >= 0) score += 300;
    else if (round.indexOf("round of 16") >= 0) score += 200;
    else score += 100; // group stage
  }

  if (tierInfo.leagueId === 13 || tierInfo.leagueId === 11) {
    var isKnockout = ["round of 16","quarter","semi","final"]
      .some(function(k){ return round.indexOf(k) >= 0; });
    if (!isKnockout) return -1;
    var homeTeam = (fixture.teams && fixture.teams.home && fixture.teams.home.name) || "";
    var awayTeam = (fixture.teams && fixture.teams.away && fixture.teams.away.name) || "";
    var isBig = BIG_LATAM.some(function(t){
      return homeTeam.indexOf(t) >= 0 || awayTeam.indexOf(t) >= 0;
    });
    if (!isBig) return -1;
    score += 100;
  }

  // El Clasico / big rivalry bonus
  var home = ((fixture.teams && fixture.teams.home && fixture.teams.home.name) || "").toLowerCase();
  var away = ((fixture.teams && fixture.teams.away && fixture.teams.away.name) || "").toLowerCase();
  if (
    (home.indexOf("real madrid") >= 0 && away.indexOf("barcelona") >= 0) ||
    (home.indexOf("barcelona")   >= 0 && away.indexOf("real madrid") >= 0) ||
    (home.indexOf("milan")       >= 0 && away.indexOf("inter") >= 0) ||
    (home.indexOf("man city")    >= 0 && away.indexOf("arsenal") >= 0)
  ) score += 200;

  return score;
}

// ── Upsert to Supabase ─────────────────────────────────────────
function upsertToSupabase(row) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify([row]);
    var urlParts = require("url").parse(SUPABASE_URL + "/rest/v1/featured_match");
    var opts = {
      hostname: urlParts.hostname,
      path:     urlParts.path,
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body),
        "apikey":        SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Prefer":        "resolution=merge-duplicates"
      }
    };
    var req = https.request(opts, function(res) {
      var data = "";
      res.on("data", function(d){ data += d; });
      res.on("end", function(){
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error("Supabase " + res.statusCode + ": " + data));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log("Starting match fetch — " + new Date().toISOString());

  var today    = todayStr();
  var tomorrow = tomorrowStr();
  var best = null;
  var bestScore = -Infinity;

  for (var i = 0; i < TIERS.length; i++) {
    var tierInfo = TIERS[i];
    console.log("Fetching league " + tierInfo.leagueId + " (" + tierInfo.label + ")...");
    var fixtures = await fetchFixtures(tierInfo.leagueId, today, tomorrow);
    console.log("  Found " + fixtures.length + " fixtures");

    for (var j = 0; j < fixtures.length; j++) {
      var fx = fixtures[j];
      var sc = importanceScore(fx, tierInfo);
      if (sc < 0) continue;
      if (sc > bestScore) {
        bestScore = sc;
        best = { fixture: fx, tierInfo: tierInfo };
      }
    }

    // Respect API rate limit: 10 req/min on free plan
    if (i < TIERS.length - 1) await sleep(7000);
  }

  if (!best) {
    console.log("No qualifying match found for today/tomorrow.");
    await upsertToSupabase({
      id: 1, status: "waiting",
      tournament: null, badge: null,
      home_team: null, away_team: null,
      home_logo: null, away_logo: null,
      stadium: null, kickoff_utc: null,
      tier: null, fetched_at: new Date().toISOString()
    });
    console.log("Supabase updated with waiting status.");
    return;
  }

  var fx   = best.fixture.fixture;
  var home = best.fixture.teams.home;
  var away = best.fixture.teams.away;
  var lg   = best.fixture.league;

  var row = {
    id:           1,
    status:       "upcoming",
    tournament:   lg.name,
    badge:        best.tierInfo.name,
    home_team:    home.name,
    home_logo:    home.logo,
    away_team:    away.name,
    away_logo:    away.logo,
    stadium:      (fx.venue && fx.venue.name) || lg.country || "—",
    kickoff_utc:  fx.date,
    tier:         best.tierInfo.tier,
    round:        lg.round,
    fixture_id:   fx.id,
    fetched_at:   new Date().toISOString()
  };

  console.log("Best match: " + home.name + " vs " + away.name);
  console.log("Tournament: " + lg.name + " — " + lg.round);
  console.log("Kickoff:    " + fx.date);
  console.log("Score:      " + bestScore);

  await upsertToSupabase(row);
  console.log("Supabase updated successfully.");
}

main().catch(function(e){
  console.error("Fatal error:", e.message);
  process.exit(1);
});
