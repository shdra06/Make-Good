import { paypalMode } from "../config.ts";
import { MockPayPal } from "./mock.ts";
import { SandboxPayPal } from "./sandbox.ts";
import type { PayPalApi } from "./types.ts";

export const paypal: PayPalApi = paypalMode === "sandbox" ? new SandboxPayPal() : new MockPayPal();

/** The mock instance, or null in sandbox mode. Used by the seed script. */
export const mockPayPal: MockPayPal | null = paypal instanceof MockPayPal ? paypal : null;

export * from "./types.ts";
