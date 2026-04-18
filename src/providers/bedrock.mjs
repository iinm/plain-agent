/**
 * @import { ModelInput, Message, AssistantMessage, ModelOutput, PartialMessageContent } from "../model";
 * @import { ToolDefinition } from "../tool";
 * @import { BedrockConverseModelConfig, BedrockMessage, BedrockContentBlock, BedrockAssistantContentBlock, BedrockAssistantContentBlockWithPartial, BedrockTool, BedrockStreamEvent, BedrockConverseRequest, BedrockUsage, BedrockToolResultContent } from "./bedrock";
 */

import { styleText } from "node:util";
import { abortableSleep } from "../utils/abortSignal.mjs";
import { noThrow } from "../utils/noThrow.mjs";
import { readBedrockStreamEvents } from "./platform/bedrock.mjs";

/**
 * @param {import("../modelDefinition").PlatformConfig} platformConfig
 * @param {BedrockConverseModelConfig} modelConfig
 * @param {ModelInput} input
 * @param {number} [retryCount]
 * @returns {Promise<ModelOutput | Error>}
 */
export async function callBedrockConverseModel(
  platformConfig,
  modelConfig,
  input,
  retryCount = 0,
) {
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const { HttpRequest } = await import("@smithy/protocol-http");
  const { SignatureV4 } = await import("@smithy/signature-v4");

  return await noThrow(async () => {
    const messages = convertGenericMessageToBedrockFormat(input.messages);
    const cachedMessages = modelConfig.enablePromptCaching
      ? enablePromptCaching(messages)
      : messages;
    const tools = convertGenericToolDefinitionToBedrockFormat(
      input.tools || [],
    );

    const url = (() => {
      const baseURL = platformConfig.baseURL;
      if (platformConfig.name !== "bedrock") {
        throw new Error(`Unsupported platform: ${platformConfig.name}`);
      }
      return `${baseURL}/model/${modelConfig.model}/converse-stream`;
    })();

    const region = extractRegionFromBaseURL(platformConfig.baseURL);

    /** @type {BedrockConverseRequest} */
    const request = {
      messages: cachedMessages,
      ...(modelConfig.inferenceConfig && {
        inferenceConfig: modelConfig.inferenceConfig,
      }),
      ...(modelConfig.additionalModelRequestFields && {
        additionalModelRequestFields: modelConfig.additionalModelRequestFields,
      }),
    };

    // Add system messages if present
    const systemMessages = extractSystemMessages(
      input.messages,
      modelConfig.enablePromptCaching,
    );
    if (systemMessages.length > 0) {
      request.system = systemMessages;
    }

    // Add tools if present
    if (tools.length > 0) {
      request.toolConfig = {
        tools: tools,
      };
    }

    const payload = JSON.stringify(request);

    // Sign request with AWS Signature V4
    const signer = new SignatureV4({
      credentials: fromIni({ profile: platformConfig.awsProfile }),
      region,
      service: "bedrock",
      sha256: Sha256,
    });

    const urlParsed = new URL(url);
    const { hostname, pathname } = urlParsed;

    const req = new HttpRequest({
      protocol: "https:",
      method: "POST",
      hostname,
      path: pathname,
      headers: {
        host: hostname,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    const signed = await signer.sign(req);

    const response = await fetch(url, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
      signal: input.signal
        ? AbortSignal.any([AbortSignal.timeout(8 * 60 * 1000), input.signal])
        : AbortSignal.timeout(8 * 60 * 1000),
    });

    if (response.status !== 200) {
      const errorText = await response.text();
      console.error(
        styleText("red", `Bedrock API error: ${response.status} ${errorText}`),
      );

      // Retry on throttling or server errors
      if (
        (response.status === 429 ||
          response.status === 502 ||
          response.status === 503) &&
        retryCount < 3
      ) {
        const retryInterval = Math.min(2 * 2 ** retryCount, 16);
        console.error(
          styleText(
            "yellow",
            `Retrying in ${retryInterval} seconds... (attempt ${retryCount + 1})`,
          ),
        );
        await abortableSleep(retryInterval * 1000, input.signal);
        return callBedrockConverseModel(
          platformConfig,
          modelConfig,
          input,
          retryCount + 1,
        );
      }

      throw new Error(`Bedrock API error: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Response body is empty");
    }

    const reader = response.body.getReader();

    /** @type {BedrockAssistantContentBlockWithPartial[]} */
    const contentBlocks = [];
    /** @type {Record<number, BedrockAssistantContentBlockWithPartial>} */
    const contentBlockMap = {};
    /** @type {BedrockUsage | undefined} */
    let usage;

    // Process stream events
    for await (const event of readBedrockStreamEvents(reader)) {
      const bedrockEvent = /** @type {BedrockStreamEvent} */ (event);

      if (input.onPartialMessageContent) {
        const partialContents = convertBedrockStreamEventToPartialContent(
          bedrockEvent,
          contentBlockMap,
        );
        for (const partialContent of partialContents) {
          input.onPartialMessageContent(partialContent);
        }
      }

      // Handle Converse API events (flat structure)
      // Check for start event first
      if ("contentBlockIndex" in bedrockEvent && "start" in bedrockEvent) {
        const index = bedrockEvent.contentBlockIndex;
        const start = bedrockEvent.start;

        if (start.toolUse) {
          contentBlockMap[index] = {
            toolUse: {
              toolUseId: start.toolUse.toolUseId || "",
              name: start.toolUse.name || "",
              input: {},
            },
          };
        }
      }

      if ("contentBlockIndex" in bedrockEvent && "delta" in bedrockEvent) {
        const index = bedrockEvent.contentBlockIndex;
        const delta = bedrockEvent.delta;

        // Initialize content block if not exists
        if (!contentBlockMap[index]) {
          if (delta.text !== undefined) {
            contentBlockMap[index] = { text: "" };
          } else if (delta.toolUse) {
            contentBlockMap[index] = {
              toolUse: {
                toolUseId: delta.toolUse.toolUseId || "",
                name: delta.toolUse.name || "",
                input: {},
              },
            };
          } else if (delta.reasoningContent) {
            contentBlockMap[index] = {
              reasoningContent: {
                text: undefined,
                signature: undefined,
                redactedContent: undefined,
              },
            };
          }
        }

        const block = contentBlockMap[index];

        // Accumulate content
        if (block && delta.text !== undefined && "text" in block) {
          block.text += delta.text;
        } else if (
          block &&
          delta.toolUse &&
          "toolUse" in block &&
          block.toolUse
        ) {
          // Accumulate tool input as JSON string
          if (!block._partialInput) {
            block._partialInput = "";
          }
          block._partialInput += delta.toolUse.input || "";
        } else if (
          block &&
          delta.reasoningContent &&
          "reasoningContent" in block &&
          block.reasoningContent
        ) {
          if (delta.reasoningContent.text) {
            block.reasoningContent.text =
              (block.reasoningContent.text || "") + delta.reasoningContent.text;
          }
          if (delta.reasoningContent.signature) {
            block.reasoningContent.signature = delta.reasoningContent.signature;
          }
          if (delta.reasoningContent.redactedContent) {
            block.reasoningContent.redactedContent =
              delta.reasoningContent.redactedContent;
          }
        }
      }

      // Handle message stop
      if ("stopReason" in bedrockEvent) {
        // Finalize all content blocks
        for (const [_index, block] of Object.entries(contentBlockMap)) {
          // Parse accumulated tool input JSON
          if (
            block &&
            "toolUse" in block &&
            block.toolUse &&
            block._partialInput
          ) {
            try {
              block.toolUse.input = JSON.parse(block._partialInput);
            } catch (err) {
              console.error(
                styleText(
                  "red",
                  `Failed to parse tool input JSON for tool "${block.toolUse.name}": ${block._partialInput}`,
                ),
              );
              block.toolUse.input = {
                err: String(err),
                raw: block._partialInput,
              };
            }
            delete block._partialInput;
          }
          contentBlocks.push(block);
        }
      }

      // Handle metadata
      if ("usage" in bedrockEvent && "metrics" in bedrockEvent) {
        usage = bedrockEvent.usage;
      }
    }

    const message =
      convertBedrockContentBlocksToAssistantMessage(contentBlocks);

    const providerTokenUsage = usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.cacheReadInputTokens && {
            cacheReadInputTokens: usage.cacheReadInputTokens,
          }),
          ...(usage.cacheWriteInputTokens && {
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
          }),
        }
      : {};

    return {
      message,
      providerTokenUsage,
    };
  });
}

/**
 * @param {Message[]} messages
 * @returns {BedrockMessage[]}
 */
function convertGenericMessageToBedrockFormat(messages) {
  /** @type {BedrockMessage[]} */
  const bedrockMessages = [];

  for (const message of messages) {
    if (message.role === "system") {
      // System messages handled separately
      continue;
    }

    if (message.role === "user") {
      /** @type {BedrockContentBlock[]} */
      const content = [];

      for (const part of message.content) {
        if (part.type === "text" && part.text) {
          // Only include non-empty text blocks
          content.push({ text: part.text });
        } else if (part.type === "image") {
          content.push({
            image: {
              format: /** @type {"png" | "jpeg" | "gif" | "webp"} */ (
                part.mimeType.split("/")[1]
              ),
              source: {
                bytes: part.data,
              },
            },
          });
        } else if (part.type === "tool_result") {
          /** @type {BedrockToolResultContent[]} */
          const toolResultContent = [];
          for (const resultPart of part.content) {
            if (resultPart.type === "text") {
              toolResultContent.push({ text: resultPart.text });
            } else if (resultPart.type === "image") {
              toolResultContent.push({
                image: {
                  format: /** @type {"png" | "jpeg" | "gif" | "webp"} */ (
                    resultPart.mimeType.split("/")[1]
                  ),
                  source: {
                    bytes: resultPart.data,
                  },
                },
              });
            }
          }

          content.push({
            toolResult: {
              toolUseId: part.toolUseId,
              content: toolResultContent,
              status: part.isError ? "error" : "success",
            },
          });
        }
      }

      bedrockMessages.push({ role: "user", content });
    } else if (message.role === "assistant") {
      /** @type {BedrockAssistantContentBlock[]} */
      const content = [];

      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ text: part.text });
        } else if (part.type === "thinking") {
          // Extended thinking requires signature for multi-turn conversations
          const signature = /** @type {string | undefined} */ (
            part.provider?.fields?.signature
          );
          if (signature) {
            content.push({
              reasoningContent: {
                reasoningText: {
                  text: part.thinking,
                  signature,
                },
              },
            });
          }
        } else if (part.type === "redacted_thinking") {
          // Redacted thinking must be included in message history
          const data = /** @type {string | undefined} */ (
            part.provider?.fields?.data
          );
          if (data) {
            content.push({
              reasoningContent: {
                redactedContent: data,
              },
            });
          }
        } else if (part.type === "tool_use") {
          content.push({
            toolUse: {
              toolUseId: part.toolUseId,
              name: part.toolName,
              input: part.input,
            },
          });
        }
      }

      bedrockMessages.push({ role: "assistant", content });
    }
  }

  return bedrockMessages;
}

/**
 * @param {Message[]} messages
 * @param {boolean} [enablePromptCaching]
 * @returns {import("./bedrock").BedrockSystemContentBlock[]}
 */
function extractSystemMessages(messages, enablePromptCaching = false) {
  /** @type {import("./bedrock").BedrockSystemContentBlock[]} */
  const systemBlocks = [];

  for (const message of messages) {
    if (message.role === "system") {
      for (const part of message.content) {
        systemBlocks.push({ text: part.text });
      }
    }
  }

  // Add cache point at the end of system messages if enabled
  if (enablePromptCaching && systemBlocks.length > 0) {
    systemBlocks.push({ cachePoint: { type: "default" } });
  }

  return systemBlocks;
}

/**
 * @param {ToolDefinition[]} tools
 * @returns {BedrockTool[]}
 */
function convertGenericToolDefinitionToBedrockFormat(tools) {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: tool.inputSchema,
      },
    },
  }));
}

/**
 * @param {BedrockMessage[]} messages
 * @returns {BedrockMessage[]}
 */
function enablePromptCaching(messages) {
  // Find user message indices
  const userMessageIndices = messages
    .map((msg, index) => (msg.role === "user" ? index : -1))
    .filter((index) => index !== -1);

  // Target last two user messages for caching
  const cacheTargetIndices = [
    userMessageIndices.at(-1),
    userMessageIndices.at(-2),
  ].filter((index) => index !== undefined);

  const cachedMessages = messages.map((message, index) => {
    if (cacheTargetIndices.includes(index)) {
      // Add cache point as a separate block at the end
      // Only add to messages without tool results (tool results don't support cachePoint)
      if (message.role === "user") {
        const content = /** @type {BedrockContentBlock[]} */ ([
          ...message.content,
        ]);
        // Check if content contains toolResult
        const hasToolResult = content.some(
          (block) => "toolResult" in block && block.toolResult,
        );
        if (!hasToolResult) {
          content.push({ cachePoint: { type: "default" } });
          return { ...message, content };
        }
      }
      if (message.role === "assistant") {
        const content = /** @type {BedrockAssistantContentBlock[]} */ ([
          ...message.content,
        ]);
        content.push({ cachePoint: { type: "default" } });
        return { ...message, content };
      }
    }
    return message;
  });

  return cachedMessages;
}

/**
 * @param {BedrockStreamEvent} event
 * @param {Record<number, import("./bedrock").BedrockAssistantContentBlockWithPartial>} contentBlockMap
 * @returns {PartialMessageContent[]}
 */
function convertBedrockStreamEventToPartialContent(event, contentBlockMap) {
  /** @type {PartialMessageContent[]} */
  const partialContents = [];

  // Handle Converse API events (flat structure)
  // Note: Don't send message start event here
  // Each content block will send its own start event

  // Handle tool use start event
  if ("contentBlockIndex" in event && "start" in event) {
    const index = event.contentBlockIndex;
    const start = event.start;

    // Send stop event for previous block if exists
    if (index > 0 && contentBlockMap[index - 1]) {
      const prevBlock = contentBlockMap[index - 1];
      const prevType = prevBlock.text
        ? "text"
        : prevBlock.toolUse
          ? "tool_use"
          : prevBlock.reasoningContent
            ? "thinking"
            : "unknown";

      partialContents.push({
        type: prevType,
        position: "stop",
      });
    }

    if (start.toolUse) {
      partialContents.push({
        type: "tool_use",
        position: "start",
        content: JSON.stringify({
          toolUseId: start.toolUse.toolUseId,
          name: start.toolUse.name,
        }),
      });
    }
  }

  if ("contentBlockIndex" in event && "delta" in event) {
    const delta = event.delta;
    const index = event.contentBlockIndex;

    // Check if this is a new block (no entry in contentBlockMap)
    // If so, send stop event for previous block first
    if (!contentBlockMap[index] && index > 0 && contentBlockMap[index - 1]) {
      const prevBlock = contentBlockMap[index - 1];
      const prevType = prevBlock.text
        ? "text"
        : prevBlock.toolUse
          ? "tool_use"
          : prevBlock.reasoningContent
            ? "thinking"
            : "unknown";

      partialContents.push({
        type: prevType,
        position: "stop",
      });
    }

    if (delta.text !== undefined) {
      // Send start event if this is a new text block
      if (!contentBlockMap[index]) {
        partialContents.push({
          type: "text",
          position: "start",
          content: "",
        });
      }
      partialContents.push({
        type: "text",
        position: "delta",
        content: delta.text,
      });
    } else if (delta.toolUse) {
      // Don't send tool input deltas to onPartialMessageContent
      // Tool input will be shown when tool call is complete
    } else if (delta.reasoningContent) {
      // Send start event if this is a new reasoningContent block
      if (!contentBlockMap[index]) {
        partialContents.push({
          type: "thinking",
          position: "start",
          content: "",
        });
      }
      // Reasoning content (text or redactedContent)
      if (delta.reasoningContent.text) {
        partialContents.push({
          type: "thinking",
          position: "delta",
          content: delta.reasoningContent.text,
        });
      }
      // Note: redactedContent is encrypted, so we don't display it
      // but we still need to track it for the final message
    }
  }

  if ("stopReason" in event) {
    // Message stop event
    const blocks = Object.values(contentBlockMap);
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1];
      const type =
        lastBlock && "text" in lastBlock
          ? "text"
          : lastBlock && "toolUse" in lastBlock
            ? "tool_use"
            : lastBlock && "reasoningContent" in lastBlock
              ? "thinking"
              : "unknown";

      partialContents.push({
        type,
        position: "stop",
      });
    }
  }

  return partialContents;
}

/**
 * @param {BedrockAssistantContentBlockWithPartial[]} contentBlocks
 * @returns {AssistantMessage}
 */
function convertBedrockContentBlocksToAssistantMessage(contentBlocks) {
  /** @type {AssistantMessage["content"]} */
  const content = [];

  for (const block of contentBlocks) {
    if (block.text) {
      // Only include non-empty text blocks
      content.push({
        type: "text",
        text: block.text,
      });
    } else if (block.toolUse) {
      content.push({
        type: "tool_use",
        toolUseId: block.toolUse.toolUseId || "",
        toolName: block.toolUse.name || "",
        input:
          /** @type {Record<string, unknown>} */ (block.toolUse.input) ??
          /** @type {Record<string, unknown>} */ ({}),
      });
    } else if (block.reasoningContent) {
      // Reasoning content
      if (block.reasoningContent.text) {
        content.push({
          type: "thinking",
          thinking: block.reasoningContent.text,
          ...(block.reasoningContent.signature && {
            provider: {
              fields: { signature: block.reasoningContent.signature },
            },
          }),
        });
      } else if (block.reasoningContent.redactedContent) {
        content.push({
          type: "redacted_thinking",
          provider: {
            fields: { data: block.reasoningContent.redactedContent },
          },
        });
      }
    }
  }

  return {
    role: "assistant",
    content,
  };
}

/**
 * @param {string} baseURL
 * @returns {string}
 */
function extractRegionFromBaseURL(baseURL) {
  const match = baseURL.match(/bedrock-runtime\.([^.]+)\.amazonaws\.com/);
  if (!match) {
    throw new Error(`Failed to extract region from baseURL: ${baseURL}`);
  }
  return match[1];
}
