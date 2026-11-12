import type { Metadata } from "next";

export const metadata: Metadata = { title: "How AI is used" };

export default function AiPage() {
  return (
    <>
      <h1>How AI is used</h1>
      <p>
        Make Good can use Google&apos;s Gemini model for three tasks. In each, the AI proposes and a person decides: its output is checked against the source,
        and nothing it says changes who is paid until a member of staff accepts it.
      </p>

      <h2>What Gemini is sent</h2>
      <ul>
        <li>
          <strong>Reading a supplier&apos;s notice:</strong> the text of the notice the shop pasted. Every rule it proposes must quote the notice; a rule whose
          quote is not in the notice is dropped.
        </li>
        <li>
          <strong>Spotting product names that mean the same thing:</strong> product codes and product titles from the shop&apos;s orders.
        </li>
        <li>
          <strong>Explaining why a record is held:</strong> the matching evidence for that record, such as order numbers, dates, product codes and amounts, with
          email addresses masked.
        </li>
      </ul>

      <h2>What Gemini is never sent</h2>
      <ul>
        <li>Customer names or email addresses.</li>
        <li>PayPal or store credentials, or staff accounts.</li>
      </ul>

      <h2>Switching it off</h2>
      <p>
        A shop owner or admin can switch AI off for the whole workspace in Settings. The notice is then read by fixed pattern rules, and the other two tasks are
        not offered. The server operator can also leave it off entirely by not setting a Gemini key.
      </p>

      <h2>Google&apos;s use of the data</h2>
      <p>
        Requests go to Google&apos;s Gemini API under the operator&apos;s key and Google&apos;s API terms. Whether Google may keep or use the requests depends
        on that key&apos;s plan; a paid plan should be used before handling real customer data.
      </p>
    </>
  );
}
