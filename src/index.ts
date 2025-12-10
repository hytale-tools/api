import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CookieJar } from "tough-cookie";
import fetchCookie from "fetch-cookie";

const CREDENTIALS = {
  identifier: process.env.HYTALE_EMAIL!,
  password: process.env.HYTALE_PASSWORD!,
};

if (!CREDENTIALS.identifier || !CREDENTIALS.password) {
  console.error("Missing HYTALE_EMAIL or HYTALE_PASSWORD in .env");
  process.exit(1);
}

const cookieJar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, cookieJar);

async function isLoggedIn(): Promise<boolean> {
  const response = await fetchWithCookies(
    "https://accounts.hytale.com/api/account/username-reservations/availability?username=test",
    { redirect: "manual" }
  );
  return response.status === 200 || response.status === 400;
}

async function getSessionExpiry(): Promise<Date | null> {
  const cookies = await cookieJar.getCookies("https://hytale.com");
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
  if (!(await isLoggedIn())) {
    console.log("Session expired, logging in...");
    await login();
  }
}

async function checkUsername(username: string): Promise<boolean> {
  const response = await fetchWithCookies(
    `https://accounts.hytale.com/api/account/username-reservations/availability?username=${encodeURIComponent(username)}`
  );
  return response.status === 200;
}

await ensureLoggedIn();

const app = new Elysia()
  .use(cors({ origin: "*" }))
  .get("/", () => ({
    message: "Hytale Username Checker API",
    endpoints: {
      "GET /check/:username": "Check if a username is available",
      "GET /status": "Get session status",
    },
  }))
  .get("/check/:username", async ({ params }) => {
    await ensureLoggedIn();
    
    const { username } = params;
    const available = await checkUsername(username);

    console.log(`Username "${username}" is ${available ? "available" : "taken"}`);
    
    return {
      username,
      available,
    };
  })
  .get("/status", async () => {
    const loggedIn = await isLoggedIn();
    const expiresAt = await getSessionExpiry();
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
