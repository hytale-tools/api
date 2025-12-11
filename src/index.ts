import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CookieJar } from "tough-cookie";
import fetchCookie from "fetch-cookie";
import { Ratelimit } from "@upstash/ratelimit";
import Redis from "ioredis";
import { createIoRedisAdapter } from "./redis";

const CREDENTIALS = {
  identifier: process.env.HYTALE_EMAIL!,
  password: process.env.HYTALE_PASSWORD!,
};

if (!CREDENTIALS.identifier || !CREDENTIALS.password) {
  console.error("Missing HYTALE_EMAIL or HYTALE_PASSWORD in .env");
  process.exit(1);
}

// Redis cache
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const CACHE_PREFIX = "hytale:username:";
const AVAILABLE_TTL = 60; // 1 minute for available names

const ratelimit = new Ratelimit({
  redis: createIoRedisAdapter(redis),
  limiter: Ratelimit.slidingWindow(30, "60 s"), // 30 requests per minute
  prefix: "hytale:ratelimit",
});

async function getCachedAvailability(username: string): Promise<boolean | null> {
  const cached = await redis.get(`${CACHE_PREFIX}${username.toLowerCase()}`);
  if (cached === null) return null;
  return cached === "1";
}

async function setCachedAvailability(username: string, available: boolean): Promise<void> {
  const key = `${CACHE_PREFIX}${username.toLowerCase()}`;
  if (available) {
    // Available names cached for 1 minute
    await redis.set(key, "1", "EX", AVAILABLE_TTL);
  } else {
    // Taken names cached forever
    await redis.set(key, "0");
  }
}

const cookieJar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, cookieJar);

function isSessionValid(): boolean {
  const cookies = cookieJar.getCookiesSync("https://hytale.com");
  const sessionCookie = cookies.find(c => c.key === "ory_kratos_session");
  if (!sessionCookie?.expires) return false;
  
  // Consider session invalid 5 minutes before actual expiry for safety margin
  const expiresAt = new Date(sessionCookie.expires).getTime();
  return Date.now() < expiresAt - 5 * 60 * 1000;
}

function getSessionExpiry(): Date | null {
  const cookies = cookieJar.getCookiesSync("https://hytale.com");
  const sessionCookie = cookies.find(c => c.key === "ory_kratos_session");
  if (sessionCookie?.expires) {
    return new Date(sessionCookie.expires);
  }
  return null;
}

async function login(): Promise<void> {
  console.log("Initializing login flow...");
  const initResponse = await fetchWithCookies(
    "https://backend.accounts.hytale.com/self-service/login/browser",
    { redirect: "manual" }
  );

  const location = initResponse.headers.get("location");
  const flowMatch = location?.match(/flow=([a-f0-9-]+)/);
  if (!flowMatch) {
    throw new Error("Could not extract flow ID");
  }
  const flowId = flowMatch[1];
  console.log("Flow ID:", flowId);

  const cookies = await cookieJar.getCookies("https://backend.accounts.hytale.com");
  const csrfCookie = cookies.find(c => c.key.startsWith("csrf_token"));
  if (!csrfCookie) {
    throw new Error("Could not find CSRF token cookie");
  }

  console.log("Submitting login...");
  const formData = new URLSearchParams({
    csrf_token: csrfCookie.value,
    identifier: CREDENTIALS.identifier,
    password: CREDENTIALS.password,
    method: "password",
  });

  const loginResponse = await fetchWithCookies(
    `https://backend.accounts.hytale.com/self-service/login?flow=${flowId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
      redirect: "manual",
    }
  );

  const redirectLocation = loginResponse.headers.get("location");
  if (loginResponse.status !== 303 || !redirectLocation?.includes("/settings")) {
    const body = await loginResponse.text();
    throw new Error(`Login failed: ${loginResponse.status} - ${body.slice(0, 200)}`);
  }

  await fetchWithCookies(redirectLocation, { redirect: "follow" });
  console.log("Login successful!");
}

async function ensureLoggedIn(): Promise<void> {
  if (isSessionValid()) return;

  console.log("Session expired, logging in...");
  
  try {
    await login();
  } catch (error) {
    console.error("Failed to login, terminating...");
    process.kill(process.pid, "SIGTERM");
  }
}

type CheckResult = 
  | { ok: true; available: boolean; cached: boolean }
  | { ok: false; error: "hytale_api_error"; status: number }
  | { ok: false; error: "rate_limited"; retryAfter: number };

async function checkUsername(username: string, ip: string): Promise<CheckResult> {
  // Check cache first - no rate limit needed for cached
  const cached = await getCachedAvailability(username);
  
  if (cached !== null) {
    return { ok: true, available: cached, cached: true };
  }

  // Not cached - check rate limit before hitting API
  const rateLimit = await ratelimit.limit("check_username", {
    ip
  });

  if (!rateLimit.success) {
    return { ok: false, error: "rate_limited", retryAfter: Math.ceil((rateLimit.reset - Date.now()) / 1000) };
  }

  // Check API
  const response = await fetchWithCookies(
    `https://accounts.hytale.com/api/account/username-reservations/availability?username=${encodeURIComponent(username)}`
  );

  if (response.status !== 200 && response.status !== 400) {
    console.error(`Hytale API error: ${response.status}`);
    return { ok: false, error: "hytale_api_error", status: response.status };
  }

  const available = response.status === 200;

  // Cache the result
  await setCachedAvailability(username, available);

  return { ok: true, available, cached: false };
}

await ensureLoggedIn();
console.log("Connected to Redis");

const app = new Elysia()
  .use(cors({ origin: "*" }))
  .get("/", () => ({
    message: "Hytale Username Checker API",
    endpoints: {
      "GET /check/:username": "Check if a username is available",
      "GET /status": "Get session status",
    },
  }))
  .get("/check/:username", async ({ params, set, request, server }) => {
    await ensureLoggedIn();
    
    const ip = server?.requestIP(request)?.address ?? "unknown";
    const { username } = params;
    const result = await checkUsername(username, ip);

    if (!result.ok) {
      if (result.error === "rate_limited") {
        set.status = 429;
        set.headers["retry-after"] = String(result.retryAfter);
        return { error: "rate_limited", retryAfter: result.retryAfter };
      }
      
      set.status = 502;
      return { error: "hytale_api_error", status: result.status };
    }

    console.log(`Username "${username}" is ${result.available ? "available" : "taken"}${result.cached ? " (cached)" : ""}`);
    
    return {
      username,
      available: result.available,
      cached: result.cached,
    };
  })
  .get("/status", () => {
    const loggedIn = isSessionValid();
    const expiresAt = getSessionExpiry();
    const hoursLeft = expiresAt 
      ? (expiresAt.getTime() - Date.now()) / 1000 / 60 / 60 
      : null;

    return {
      loggedIn,
      expiresAt: expiresAt?.toISOString() ?? null,
      hoursLeft: hoursLeft ? Number(hoursLeft.toFixed(2)) : null,
    };
  })
  .listen(8080);

console.log(`🚀 Server running at http://localhost:${app.server?.port}`);
