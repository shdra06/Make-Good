// Google Gemini for the same three evidence jobs as Claude (see ai.ts).
//
// Plain HTTPS to the Gemini API, with JSON output held to a schema. The
// answer is then parsed with the same Zod schema as Claude's and goes through
// the same checks in extract.ts and service.ts. Gemini has no tools here and
// decides nothing.

import { z } from "zod";
import { AliasOpinions, prompts, RecordExplanation, type EvidenceAi } from "./ai.ts";
import { RawExtraction } from "./extract.ts";

const API = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiEvidenceAi implements EvidenceAi {
  readonly provider = "gemini" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: { apiKey: string; model: string; fetchImpl?: typeof fetch }) {
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #ask<T>(system: string, user: string, schema: z.ZodType<T>, maxTokens: number): Promise<T | null> {
    const res = await this.#fetch(`${API}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(schema, { io: "output" }),
          maxOutputTokens: maxTokens * 4, // room for the model's own reasoning tokens
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => null)) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      error?: { message?: string };
    } | null;
    if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${body?.error?.message ?? "no detail"}`.slice(0, 300));
    const candidate = body?.candidates?.[0];
    if (!candidate || candidate.finishReason === "SAFETY" || candidate.finishReason === "MAX_TOKENS") return null;
    const text = (candidate.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const checked = schema.safeParse(parsed);
    return checked.success ? checked.data : null;
  }

  readNotice(input: Parameters<EvidenceAi["readNotice"]>[0]) {
    const p = prompts.notice(input);
    return this.#ask(p.system, p.user, RawExtraction, 6000);
  }

  judgeAliases(input: Parameters<EvidenceAi["judgeAliases"]>[0]) {
    const p = prompts.aliases(input);
    return this.#ask(p.system, p.user, AliasOpinions, 4000);
  }

  explainRecord(input: Parameters<EvidenceAi["explainRecord"]>[0]) {
    const p = prompts.explain(input);
    return this.#ask(p.system, p.user, RecordExplanation, 3000);
  }
}
