import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p>
        Make Good helps a shop find which of its customers are owed money after a product recall and refund them through PayPal. This page says what data it
        keeps, why, and who else sees it.
      </p>

      <h2>Two kinds of people</h2>
      <ul>
        <li>
          <strong>Shop staff</strong> who sign in. The shop is responsible for its own customers&apos; data; Make Good processes it on the shop&apos;s behalf.
        </li>
        <li>
          <strong>The shop&apos;s customers</strong>, whose orders and PayPal payments the shop imports, and who may answer a one-time confirmation link or send
          a claim.
        </li>
      </ul>

      <h2>What is kept</h2>
      <ul>
        <li>Staff: name, email, a password hash (never the password), sign-in sessions, and every action on the audit trail.</li>
        <li>Customers: name, email, order details, PayPal payment IDs and amounts, answers to confirmation links, claims and photos sent with them.</li>
        <li>Emails sent to customers, word for word, so staff can see what each customer was told.</li>
      </ul>

      <h2>How it is protected</h2>
      <ul>
        <li>Customer names, emails, letters and raw PayPal and store data are encrypted in the database (AES-256-GCM). Emails are matched by a keyed hash.</li>
        <li>Each shop&apos;s data is separated by the database itself (row-level security), not only by the application.</li>
        <li>PayPal and store credentials are encrypted. Links in emails work once and expire.</li>
      </ul>

      <h2>Who else sees it</h2>
      <ul>
        <li>
          <strong>PayPal</strong>, to look up payments and send refunds.
        </li>
        <li>
          <strong>Google (Gemini)</strong>, only if the shop leaves AI on, and never customer names or emails. See <Link href="/ai">how AI is used</Link>.
        </li>
        <li>
          <strong>Resend</strong>, to deliver emails, when the operator switches email sending on.
        </li>
        <li>
          <strong>The hosting provider</strong> (Render), which stores the database.
        </li>
      </ul>
      <p>Nothing is sold or used for advertising.</p>

      <h2>How long</h2>
      <p>
        Data stays while the shop&apos;s workspace exists, because refunds and their records must be explainable later. A shop owner can download all of the
        workspace&apos;s data in Settings. Deleting a workspace on request removes its data; the audit trail of payments may need to be kept longer where the
        law requires financial records.
      </p>

      <h2>Your rights</h2>
      <p>
        Customers should contact the shop they bought from first; the shop can export, correct or delete their records. Staff can ask the workspace owner, or
        the operator of this service.
      </p>
    </>
  );
}
