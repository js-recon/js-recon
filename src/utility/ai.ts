import OpenAI from "openai";
import { Ollama } from "ollama";
import Anthropic from "@anthropic-ai/sdk";
import * as globals from "./globals.js";

/**
 * OpenAI client instance.
 *
 * @remarks
 * This client is used to communicate with the OpenAI API.
 * The base URL and API key are configurable via the
 * `setAiEndpoint` and `setAiApiKey` functions.
 */
const openai_client = new OpenAI({
    baseURL: globals.getAiEndpoint() || "https://api.openai.com/v1",
    apiKey: globals.getAiApiKey(),
});

/**
 * Ollama client instance.
 *
 * @remarks
 * This client is used to communicate with the Ollama API.
 * The host is configurable via the `setAiEndpoint` function.
 */
const ollama_client = new Ollama({
    host: globals.getAiEndpoint() || "http://127.0.0.1:11434",
});

/**
 * Anthropic client instance.
 *
 * @remarks
 * This client is used to communicate with the Anthropic Messages API.
 * The API key is configurable via the `setAiApiKey` function.
 */
const anthropic_client = new Anthropic({
    apiKey: globals.getAiApiKey(),
});

/**
 * Returns an AI client instance based on the configured provider.
 *
 * @returns {Object} An object containing the AI client and the configured model.
 */
const ai = async (): Promise<{ client: OpenAI | Ollama | Anthropic; model: string }> => {
    const model = globals.getAiModel();
    const provider = globals.getAiServiceProvider();

    if (provider === "openai") {
        return { client: openai_client, model };
    }

    if (provider === "ollama") {
        return { client: ollama_client, model };
    }

    if (provider === "anthropic") {
        return { client: anthropic_client, model };
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
        // @ts-ignore
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
        // @ts-ignore
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

export { ai, openai_client, ollama_client, anthropic_client, getCompletion };
