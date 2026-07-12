import OpenAI from "openai";

const SAFETY_PROMPT = `
Review this uploaded image for a portrait background-removal service.
Return strict JSON with:
- decision: one of allow, block, review_required
- reasonCode: short snake_case string
- summary: short plain-English summary
- flags: array of short snake_case category flags
- confidence: number from 0 to 1

Block illegal, exploitative, or abusive content, including minors in sexual contexts, graphic violence, self-harm, or illegal abuse.
Use review_required for uncertain or borderline cases.
Use allow only when the image is clearly acceptable for processing.
`;

function extractJsonContent(messageContent) {
  if (!Array.isArray(messageContent)) {
    return "";
  }

  for (const part of messageContent) {
    if (part.type === "text" && part.text) {
      return part.text;
    }
  }

  return "";
}

export function createModerationService(runtimeConfig) {
  const provider = runtimeConfig.moderationProvider || "disabled";

  if (provider === "disabled") {
    return {
      isActive() {
        return false;
      },
      async getReadiness() {
        return { ok: !runtimeConfig.moderationFailClosed, detail: "Moderation disabled." };
      },
      async moderateUpload() {
        return {
          decision: "allow",
          provider: "disabled",
          reasonCode: "disabled",
          summary: "Moderation disabled.",
          flags: [],
          confidence: 1,
        };
      },
    };
  }

  if (provider !== "openai") {
    return {
      isActive() {
        return false;
      },
      async getReadiness() {
        return { ok: false, detail: `Unsupported moderation provider: ${provider}.` };
      },
      async moderateUpload() {
        throw new Error(`Unsupported moderation provider: ${provider}.`);
      },
    };
  }

  const client = new OpenAI({
    apiKey: runtimeConfig.openAiApiKey,
  });

  return {
    isActive() {
      return true;
    },
    async getReadiness() {
      if (!runtimeConfig.openAiApiKey) {
        return { ok: false, detail: "OPENAI_API_KEY is not configured." };
      }

      return { ok: true, detail: "configured" };
    },
    async moderateUpload(buffer, metadata = {}) {
      const completion = await client.chat.completions.create({
        model: runtimeConfig.moderationModel,
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content: SAFETY_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Request ID: ${metadata.requestId || "unknown"}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${metadata.mimeType || "image/png"};base64,${buffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
      });

      const content = extractJsonContent(completion.choices[0]?.message?.content);
      const parsed = JSON.parse(content || "{}");

      return {
        decision: parsed.decision || "review_required",
        provider: "openai",
        reasonCode: parsed.reasonCode || "unknown",
        summary: parsed.summary || "Moderation result unavailable.",
        flags: Array.isArray(parsed.flags) ? parsed.flags : [],
        confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : null,
      };
    },
  };
}
