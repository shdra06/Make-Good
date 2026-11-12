// Shapes the API sends and the web app reads. Kept here so a change on one
// side is a type error on the other. Plain types and small pure helpers only:
// no runtime dependencies.

export const ROLES = ["owner", "admin", "finance_approver", "operator", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  finance_approver: "Finance approver",
  operator: "Operator",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

export type SessionUser = { id: string; email: string; name: string };

export type Membership = {
  orgId: string;
  role: Role;
  name: string;
  slug: string;
  defaultCurrency: string;
  settings: unknown;
  permissions: string[];
};

export type ServerInfo = {
  simulatorAllowed: boolean;
  livePayPalAllowed: boolean;
  partnerOnboardingAvailable: boolean;
  aiConfigured: boolean;
  aiModel: string | null;
  emailTransport: string;
  environment: "development" | "test" | "production";
};

/** GET /api/me */
export type Me = { user: SessionUser; organisations: Membership[]; server: ServerInfo };

/** Every error the API returns has this body. */
export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

/** Minor units to a display string, e.g. 5900 USD -> "$59.00". */
export function formatMoney(minor: number, currency = "USD", locale = "en-US"): string {
  const digits = ["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD"].includes(currency) ? 0 : 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    minor / 10 ** digits,
  );
}
