import { jwtVerify, SignJWT } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { getCachedSettings } from "../../lib/db/readCache";
import { isDraining } from "../../lib/gracefulShutdown";
import { checkBodySize, getBodySizeLimit } from "../../shared/middleware/bodySizeGuard";
import { generateRequestId } from "../../shared/utils/requestId";
import { applyCorsHeaders } from "../cors/origins";
import { classifyRoute } from "./classify";
import { clientApiPolicy } from "./policies/clientApi";
import { managementPolicy } from "./policies/management";
import { publicPolicy } from "./policies/public";
import {
  AUTHZ_HEADER_AUTH_ID,
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
  AUTHZ_HEADER_AUTH_SCOPES,
  AUTHZ_HEADER_REQUEST_ID,
  AUTHZ_HEADER_ROUTE_CLASS,
  AUTHZ_TRUSTED_HEADERS,
} from "./headers";
import type { AuthSubject, RouteClass, RouteClassification } from "./types";
import type { AuthOutcome, RoutePolicy } from "./context";

export interface AuthzPipelineOptions {
  enforce?: boolean;
}

const POLICIES: Record<RouteClass, RoutePolicy> = {
  PUBLIC: publicPolicy,
  CLIENT_API: clientApiPolicy,
  MANAGEMENT: managementPolicy,
};

const ADMIN_HOSTS = new Set(["admin-x7k2.qrouter.online", "admin.qrouter.online"]);
const CUSTOMER_HOSTS = new Set(["customer.qrouter.online"]);
const ROOT_PUBLIC_HOSTS = new Set(["qrouter.online", "www.qrouter.online"]);

function getRequestHost(request: NextRequest): string {
  const forwarded =
    request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host;
  const host = forwarded.split(",")[0]?.trim().toLowerCase() || "";
  return host.replace(/:\d+$/, "");
}

function isClientApiSurface(pathname: string): boolean {
  return (
    pathname === "/models" ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname === "/codex" ||
    pathname.startsWith("/codex/") ||
    pathname === "/responses" ||
    pathname.startsWith("/responses/") ||
    pathname.startsWith("/chat/") ||
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/")
  );
}

function isCustomerUsagePath(pathname: string): boolean {
  return (
    pathname === "/usage" ||
    pathname === "/api/customer/usage" ||
    pathname === "/api/customer/logs" ||
    pathname === "/api/customer/telegram-link"
  );
}

function notFoundHostResponse(request: NextRequest, requestId: string): NextResponse {
  const wantsJson =
    request.nextUrl.pathname.startsWith("/api/") ||
    (request.headers.get("accept") || "").toLowerCase().includes("application/json");
  const response = wantsJson
    ? NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Not found", correlation_id: requestId } },
        { status: 404 }
      )
    : new NextResponse("Not found", { status: 404 });
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, "PUBLIC");
  applyCorsHeaders(response, request);
  return response;
}

function stampSubject(headers: Headers, subject: AuthSubject): void {
  headers.set(AUTHZ_HEADER_AUTH_KIND, subject.kind);
  headers.set(AUTHZ_HEADER_AUTH_ID, subject.id);
  if (subject.label) headers.set(AUTHZ_HEADER_AUTH_LABEL, subject.label);
  if (subject.scopes && subject.scopes.length > 0) {
    headers.set(AUTHZ_HEADER_AUTH_SCOPES, subject.scopes.join(","));
  }
}

function rejectionResponse(
  outcome: Extract<AuthOutcome, { allow: false }>,
  classification: RouteClassification,
  requestId: string
): NextResponse {
  const response = NextResponse.json(
    {
      error: {
        code: outcome.code,
        message: outcome.message,
        correlation_id: requestId,
      },
    },
    { status: outcome.status }
  );
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
  return response;
}

function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

function isManagementDashboardRoute(
  classification: RouteClassification,
  pathname: string
): boolean {
  return classification.routeClass === "MANAGEMENT" && isDashboardPath(pathname);
}

function getCookieValue(request: NextRequest, name: string): string | null {
  const fromCookies = request.cookies.get(name)?.value;
  if (fromCookies) return fromCookies;

  const cookieHeader = request.headers.get("cookie") || request.headers.get("Cookie");
  if (!cookieHeader) return null;

  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (!rawKey || rawValue.length === 0) continue;
    if (rawKey.trim() === name) return rawValue.join("=").trim() || null;
  }

  return null;
}

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

function shouldUseSecureCookie(request: NextRequest): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https" || request.nextUrl.protocol === "https:";
}

async function refreshDashboardSessionIfNeeded(
  response: NextResponse,
  request: NextRequest
): Promise<void> {
  const secret = getJwtSecret();
  if (!secret) return;

  const token = getCookieValue(request, "auth_token");
  if (!token) return;

  try {
    const { payload } = await jwtVerify(token, secret);
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    if (!exp) return;

    const now = Math.floor(Date.now() / 1000);
    const refreshWindowSeconds = 7 * 24 * 60 * 60;
    if (exp - now >= refreshWindowSeconds) return;

    const freshToken = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(secret);

    response.cookies.set("auth_token", freshToken, {
      httpOnly: true,
      secure: shouldUseSecureCookie(request),
      sameSite: "lax",
      path: "/",
    });
  } catch (error) {
    console.error("[Authz] JWT auto-refresh failed:", error);
  }
}

function dashboardLoginRedirect(request: NextRequest, requestId: string): NextResponse {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete("auth_token");
  stampRouteResponse(response, requestId, "MANAGEMENT");
  applyCorsHeaders(response, request);
  return response;
}

function drainingResponse(requestId: string): NextResponse {
  const response = NextResponse.json(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Server is shutting down",
        correlation_id: requestId,
      },
    },
    { status: 503 }
  );
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  return response;
}

function stampRouteResponse(
  response: Response,
  requestId: string,
  routeClass: RouteClass
): Response {
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, routeClass);
  return response;
}

async function getBodySizeSettings(): Promise<Record<string, unknown> | undefined> {
  try {
    return await getCachedSettings();
  } catch (error) {
    console.warn(
      "[Authz] Failed to load request body limit settings:",
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}

export async function runAuthzPipeline(
  request: NextRequest,
  options: AuthzPipelineOptions = {}
): Promise<Response> {
  const { pathname } = request.nextUrl;
  const method = request.method;

  const requestId = generateRequestId();

  const host = getRequestHost(request);

  if (CUSTOMER_HOSTS.has(host)) {
    if (pathname === "/" || pathname === "/login" || pathname === "/dashboard/usage") {
      const response = NextResponse.redirect(new URL("/usage", request.url));
      return stampRouteResponse(response, requestId, "PUBLIC");
    }

    if (isCustomerUsagePath(pathname)) {
      const response = NextResponse.next();
      stampRouteResponse(response, requestId, "PUBLIC");
      applyCorsHeaders(response, request);
      return response;
    }

    return notFoundHostResponse(request, requestId);
  }

  if (ROOT_PUBLIC_HOSTS.has(host) && !ADMIN_HOSTS.has(host) && !isClientApiSurface(pathname)) {
    return notFoundHostResponse(request, requestId);
  }

  if (pathname === "/login") {
    const response = NextResponse.next();
    return stampRouteResponse(response, requestId, "PUBLIC");
  }

  if (pathname === "/") {
    const response = NextResponse.redirect(new URL("/dashboard", request.url));
    return stampRouteResponse(response, requestId, "MANAGEMENT");
  }

  const classification = classifyRoute(pathname, method);
  const guardedPathname = classification.normalizedPath;
  const managementDashboardRoute = isManagementDashboardRoute(classification, pathname);

  if (guardedPathname.startsWith("/api/") && isDraining()) {
    const response = drainingResponse(requestId);
    stampRouteResponse(response, requestId, classification.routeClass);
    applyCorsHeaders(response, request);
    return response;
  }

  if (guardedPathname.startsWith("/api/") && method !== "GET" && method !== "OPTIONS") {
    const bodySizeSettings = await getBodySizeSettings();
    const bodySizeRejection = checkBodySize(
      request,
      getBodySizeLimit(guardedPathname, bodySizeSettings)
    );
    if (bodySizeRejection) {
      stampRouteResponse(bodySizeRejection, requestId, classification.routeClass);
      applyCorsHeaders(bodySizeRejection, request);
      return bodySizeRejection;
    }
  }

  const requestHeaders = new Headers(request.headers);
  for (const trusted of AUTHZ_TRUSTED_HEADERS) {
    requestHeaders.delete(trusted);
  }

  requestHeaders.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
  requestHeaders.set(AUTHZ_HEADER_REQUEST_ID, requestId);

  if (method === "OPTIONS") {
    const preflight = new NextResponse(null, { status: 204 });
    preflight.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
    preflight.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
    applyCorsHeaders(preflight, request);
    return preflight;
  }

  if (!options.enforce) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
    response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
    applyCorsHeaders(response, request);
    return response;
  }

  const policy = POLICIES[classification.routeClass];
  const outcome = await policy.evaluate({ request, classification, requestId });

  if (!outcome.allow) {
    if (managementDashboardRoute) {
      return dashboardLoginRedirect(request, requestId);
    }

    const rejection = rejectionResponse(outcome, classification, requestId);
    applyCorsHeaders(rejection, request);
    return rejection;
  }

  stampSubject(requestHeaders, outcome.subject);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
  applyCorsHeaders(response, request);
  if (managementDashboardRoute) {
    await refreshDashboardSessionIfNeeded(response, request);
  }
  return response;
}
