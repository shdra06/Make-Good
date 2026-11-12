import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <>
      <h1>Terms of use</h1>
      <p>By creating an account you agree to these terms.</p>

      <h2>What the service is</h2>
      <p>
        Make Good is a tool. It proposes who is owed money after a recall and why, and it sends the refunds a person approves, through the shop&apos;s own
        PayPal account. The shop decides who is paid; Make Good never pays anyone without an approval in the app.
      </p>

      <h2>Sandbox only today</h2>
      <p>
        This build runs on the PayPal sandbox and a built-in simulator. Live payments are switched off on the server. No real money moves, and the demo uses
        invented customers.
      </p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Have the right to use the customer data you import, and tell your customers how it is used.</li>
        <li>Check the rules and decisions before approving payments. AI suggestions are suggestions.</li>
        <li>Keep your sign-in private and give team members only the role they need.</li>
      </ul>

      <h2>No warranty</h2>
      <p>
        The service is provided as it is, while it is being built. Check PayPal&apos;s own records for anything that matters. To the extent the law allows, the
        operator is not liable for losses from using it.
      </p>

      <h2>Changes</h2>
      <p>These terms may change; the date at the top says when they last did.</p>
    </>
  );
}
