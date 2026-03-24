/**
 * Shared helpers for extracting and listing config option items from
 * ACP SessionConfigOption arrays. Used by both the chat participant
 * and the webview chat panel.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "./acp-client.js";

export interface SelectOptionItem {
  label: string;
  value: string;
  description?: string;
}

/**
 * Extract the flat list of select-option items for a given config ID.
 * Returns an empty array if the config option is missing or not a select.
 */
export function selectOptionItems(
  options: SessionConfigOption[],
  configId: string,
): SelectOptionItem[] {
  let config: SessionConfigOption | undefined;
  for (const option of options) {
    if (option.id === configId && option.type === "select") {
      config = option;
      break;
    }
  }
  if (!config || config.type !== "select") {
    return [];
  }

  const result: SelectOptionItem[] = [];
  for (const optionOrGroup of config.options) {
    if ("options" in optionOrGroup) {
      for (const grouped of optionOrGroup.options) {
        result.push({
          label: grouped.name,
          value: grouped.value,
          description: grouped.description ?? undefined,
        });
      }
    } else {
      result.push({
        label: optionOrGroup.name,
        value: optionOrGroup.value,
        description: optionOrGroup.description ?? undefined,
      });
    }
  }
  return result;
}

/**
 * Get the current value for a select config option.
 */
export function getSelectCurrentValue(
  options: SessionConfigOption[],
  configId: string,
): string | undefined {
  for (const option of options) {
    if (option.id === configId && option.type === "select") {
      return option.currentValue != null ? String(option.currentValue) : undefined;
    }
  }
  return undefined;
}

/** Lightweight model entry for the webview. */
export interface ModelListEntry {
  id: string;
  label: string;
  provider: string;
}

/**
 * Fetch the list of available models from the agent.
 * Returns a simplified list suitable for dropdown display.
 */
export async function fetchModelList(
  acpClient: AcpClient,
): Promise<ModelListEntry[]> {
  if (!acpClient.isConnected) return [];

  interface AgentModelEntry {
    id: string;
    label: string;
    provider: string;
    model: string;
  }

  try {
    const resp = (await acpClient.extMethod(
      "_querymt/models",
      {},
    )) as { models?: AgentModelEntry[] };

    return (resp.models ?? [])
      .filter((m) => !!m.id)
      .map((m) => ({
        id: m.id,
        label: m.label || m.model || m.id,
        provider: m.provider ?? "",
      }));
  } catch {
    return [];
  }
}
