import { NextResponse, type NextRequest } from "next/server";

// Signed-out visitors to an app page go to sign-in first. This only checks
// that a session cookie exists; the API decides whether it is valid, and the
// app shell sends anyone with an expired session to sign-in as well.
const SESSION_COOKIE = "mg_session";

export function proxy(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/incidents/:path*"],
};
