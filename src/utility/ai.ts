import OpenAI from "openai";
import { Ollama } from "ollama";
import Anthropic from "@anthropic-ai/sdk";
import * as globals from "./globals.js";

// Clients are constructed lazily on first use, not at module load — openai's
// and anthropic's SDKs throw immediately if no API key/credentials are
// configured, which would crash every js-recon invocation, not just AI usage.
let openai_client: OpenAI | undefined;
let ollama_client: Ollama | undefined;
let anthropic_client: Anthropic | undefined;

const getOpenaiClient = (): OpenAI =>
    (openai_client ??= new OpenAI({
        baseURL: globals.getAiEndpoint() || "https://api.openai.com/v1",
        apiKey: globals.getAiApiKey(),
    }));

const getOllamaClient = (): Ollama =>
    (ollama_client ??= new Ollama({
        host: globals.getAiEndpoint() || "http://127.0.0.1:11434",
    }));

const getAnthropicClient = (): Anthropic =>
    (anthropic_client ??= new Anthropic({
        apiKey: globals.getAiApiKey(),
    }));

/**
 * Returns an AI client instance based on the configured provider.
 *
 * @returns {Object} An object containing the AI client and the configured model.
 */
const ai = async (): Promise<{ client: OpenAI | Ollama | Anthropic; model: string }> => {
    const model = globals.getAiModel();
    const provider = globals.getAiServiceProvider();

    if (provider === "openai") {
        return { client: getOpenaiClient(), model };
    }

    if (provider === "ollama") {
        return { client: getOllamaClient(), model };
    }

    if (provider === "anthropic") {
        return { client: getAnthropicClient(), model };
    }

    throw new Error(`AI service provider "${provider}" is not supported or configured.`);
};

/**
 * Asks an AI service provider to generate text based on a prompt.
 *
 * @param {string} prompt The input prompt describing the desired text output.
 * @param {string} [systemPrompt="You are a helpful assistant."] The system prompt guiding the overall tone and behavior.
 * @returns {Promise<string>} The generated text produced for the prompt.
 */
async function getCompletion(prompt, systemPrompt = "You are a helpful assistant.") {
    const { client, model } = await ai();
    const provider = globals.getAiServiceProvider();

    if (!client) {
        throw new Error(`AI service provider "${provider}" is not supported or configured.`);
    }

    if (provider === "openai") {
        // @ts-expect-error -- openai SDK types don't yet cover the Responses API shape used here
        const completion = await client.responses.create({
            input: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
            ],
            model: model || "gpt-4o-mini",
            temperature: 0.1,
        });
        return completion?.output?.[0]?.content?.[0]?.text || "none";
    }

    if (provider === "ollama") {
        const response = await ollama_client.chat({
            model: model || "llama3.1",
            messages: [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            options: {
                temperature: 0.1,
            },
        });
        return response.message.content || "none";
    }

    if (provider === "anthropic") {
        // @ts-expect-error -- openai SDK types don't yet cover the Responses API shape used here
        const response = await client.messages.create({
            model: model || "claude-haiku-4-5-20251001",
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
        });
        const text = response.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
        return text || "none";
    }
}

export { ai, getCompletion };
