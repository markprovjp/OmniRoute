import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createProviderConnection,
  createProviderNode,
  getProviderConnections,
  getProviderNodes,
  updateProviderNode,
  updateProviderConnection,
} from "@/lib/db/providers";
import { createCombo, getComboByName, updateCombo } from "@/lib/db/combos";
import { addCustomModel } from "@/lib/db/models";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { OPENAI_COMPATIBLE_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";

const DEFAULT_PROVIDER_NAME = "9Router";
const DEFAULT_PREFIX = "qrouter";
const DEFAULT_BASE_URL = "https://shopapikey.com/v1";
const DEFAULT_MODEL_ID = "gpt-5.5";
const DEFAULT_API_TYPE = "responses";
const CONNECTION_NAME_SUFFIX = "external key pool";
const CODEX_EXTERNAL_FIRST_MODEL = "cx/gpt-5.5";
const CODEX_EXTERNAL_FETCH_START_TIMEOUT_MS = 30_000;

const qrouterUpstreamSchema = z.object({
  name: z.string().trim().min(1).max(80).default(DEFAULT_PROVIDER_NAME),
  baseUrl: z.string().trim().url().max(500).default(DEFAULT_BASE_URL),
  prefix: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_-]*$/i)
    .default(DEFAULT_PREFIX),
  modelId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((value) => value.replace(/^[a-z][a-z0-9_-]*\//i, ""))
    .default(DEFAULT_MODEL_ID),
  apiKeys: z.array(z.string().trim().min(1).max(10000)).min(1).max(200),
});

type ProviderNode = {
  id: string;
  type?: string;
  name?: string;
  prefix?: string | null;
  apiType?: string | null;
  baseUrl?: string | null;
};

type ProviderConnection = {
  id: string;
  provider: string;
  name?: string | null;
  apiKey?: string | null;
  defaultModel?: string | null;
  isActive?: boolean;
  providerSpecificData?: Record<string, unknown>;
};

function normalizeBaseUrl(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

function getConnectionName(name: string): string {
  return `${name} ${CONNECTION_NAME_SUFFIX}`;
}

function uniqueApiKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

function isQrouterNode(node: ProviderNode, name = DEFAULT_PROVIDER_NAME, prefix = DEFAULT_PREFIX) {
  return (
    node.type === "openai-compatible" &&
    (node.name === name ||
      node.prefix === prefix ||
      normalizeBaseUrl(node.baseUrl) === normalizeBaseUrl(DEFAULT_BASE_URL))
  );
}

async function findQrouterNode(name = DEFAULT_PROVIDER_NAME, prefix = DEFAULT_PREFIX) {
  const nodes = (await getProviderNodes({ type: "openai-compatible" })) as ProviderNode[];
  const targetBaseUrl = normalizeBaseUrl(DEFAULT_BASE_URL);
  const matched = nodes.filter((node) => isQrouterNode(node, name, prefix));
  if (matched.length === 0) return null;
  const matchByUrl = matched.find((node) => normalizeBaseUrl(node.baseUrl) === targetBaseUrl);
  return matchByUrl || matched[0];
}

async function findQrouterConnection(nodeId: string, name = DEFAULT_PROVIDER_NAME) {
  const connections = (await getProviderConnections({ provider: nodeId })) as ProviderConnection[];
  const expectedName = getConnectionName(name);
  return (
    connections.find((connection) => connection.name === expectedName) || connections[0] || null
  );
}

function countConfiguredKeys(connection: ProviderConnection | null): number {
  if (!connection) return 0;
  const extraApiKeys = connection.providerSpecificData?.extraApiKeys;
  const extraCount = Array.isArray(extraApiKeys) ? extraApiKeys.length : 0;
  return (connection.apiKey ? 1 : 0) + extraCount;
}

function buildStatus(
  node: ProviderNode | null,
  connection: ProviderConnection | null,
  connections: ProviderConnection[] = []
) {
  const prefix = node?.prefix || DEFAULT_PREFIX;
  const modelId = connection?.defaultModel || DEFAULT_MODEL_ID;
  const isActive =
    connections.length > 0
      ? connections.some((c) => c.isActive !== false)
      : connection?.isActive !== false;
  const activeConnections = connections.filter((c) => c.isActive !== false);
  const keyCount =
    activeConnections.length > 0
      ? activeConnections.reduce((acc, c) => acc + countConfiguredKeys(c), 0)
      : countConfiguredKeys(connection);

  return {
    configured: Boolean(node && connection),
    providerId: node?.id || null,
    connectionId: connection?.id || null,
    name: node?.name || DEFAULT_PROVIDER_NAME,
    baseUrl: normalizeBaseUrl(node?.baseUrl) || DEFAULT_BASE_URL,
    prefix,
    modelId,
    model: `${prefix}/${modelId}`,
    apiType: node?.apiType || DEFAULT_API_TYPE,
    externalFirstModel: CODEX_EXTERNAL_FIRST_MODEL,
    keyCount,
    isActive,
    health:
      connection?.providerSpecificData?.apiKeyHealth &&
      typeof connection.providerSpecificData.apiKeyHealth === "object"
        ? connection.providerSpecificData.apiKeyHealth
        : {},
  };
}

async function upsertCodexExternalFirstCombo(prefix: string, modelId: string) {
  const externalModel = `${prefix}/${modelId}`;
  const models = [
    { kind: "model", model: externalModel, providerId: prefix, weight: 0 },
    { kind: "model", model: CODEX_EXTERNAL_FIRST_MODEL, providerId: "codex", weight: 0 },
  ];
  const existing = await getComboByName(CODEX_EXTERNAL_FIRST_MODEL);
  const payload = {
    name: CODEX_EXTERNAL_FIRST_MODEL,
    strategy: "priority",
    models,
    context_length: 1_050_000,
    isHidden: false,
    config: {
      externalFirst: true,
      externalModel,
      skipAvailabilityPrecheck: true,
      systemFallbackModel: CODEX_EXTERNAL_FIRST_MODEL,
    },
  };

  if (existing && typeof existing.id === "string") {
    return updateCombo(existing.id, payload);
  }

  return createCombo(payload);
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const node = await findQrouterNode();
    const connections = node
      ? ((await getProviderConnections({ provider: node.id })) as ProviderConnection[])
      : [];
    const connection = node
      ? await findQrouterConnection(node.id, node.name || DEFAULT_PROVIDER_NAME)
      : null;
    return NextResponse.json({ upstream: buildStatus(node, connection, connections) });
  } catch (error) {
    console.error("[qrouter-upstream] Failed to fetch upstream status", error);
    return NextResponse.json({ error: "Failed to fetch QRouter upstream" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { isActive } = (rawBody || {}) as { isActive?: unknown };
  if (typeof isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
  }

  try {
    const node = await findQrouterNode();
    if (!node) {
      return NextResponse.json({ error: "QRouter node not found" }, { status: 404 });
    }

    const connections = (await getProviderConnections({
      provider: node.id,
    })) as ProviderConnection[];
    for (const conn of connections) {
      await updateProviderConnection(conn.id, { isActive });
    }

    const updatedConnections = (await getProviderConnections({
      provider: node.id,
    })) as ProviderConnection[];
    const connection = node
      ? await findQrouterConnection(node.id, node.name || DEFAULT_PROVIDER_NAME)
      : null;

    return NextResponse.json({ upstream: buildStatus(node, connection, updatedConnections) });
  } catch (error) {
    console.error("[qrouter-upstream] Failed to toggle QRouter upstream status", error);
    return NextResponse.json(
      { error: "Failed to toggle QRouter upstream status" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = qrouterUpstreamSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid QRouter upstream config", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, prefix, modelId } = parsed.data;
  const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
  const apiKeys = uniqueApiKeys(parsed.data.apiKeys);

  if (apiKeys.length === 0) {
    return NextResponse.json(
      { error: "At least one upstream API key is required" },
      { status: 400 }
    );
  }

  try {
    const existingNode = await findQrouterNode(name, prefix);
    const existingConnection = existingNode
      ? await findQrouterConnection(existingNode.id, name)
      : null;
    const node = existingNode
      ? ((await updateProviderNode(existingNode.id, {
          type: "openai-compatible",
          name,
          prefix,
          apiType: DEFAULT_API_TYPE,
          baseUrl,
          chatPath: null,
          modelsPath: "/models",
        })) as ProviderNode)
      : ((await createProviderNode({
          id: `${OPENAI_COMPATIBLE_PREFIX}${DEFAULT_API_TYPE}-${generateId()}`,
          type: "openai-compatible",
          name,
          prefix,
          apiType: DEFAULT_API_TYPE,
          baseUrl,
          chatPath: null,
          modelsPath: "/models",
        })) as ProviderNode);

    await addCustomModel(node.id, modelId, `${prefix}/${modelId}`, "manual", "responses", ["chat"]);

    const existingProviderSpecificData =
      existingConnection?.providerSpecificData &&
      typeof existingConnection.providerSpecificData === "object"
        ? existingConnection.providerSpecificData
        : {};
    const connectionPayload = {
      provider: node.id,
      authType: "apikey",
      name: getConnectionName(name),
      apiKey: apiKeys[0],
      priority: 1,
      defaultModel: modelId,
      providerSpecificData: {
        ...existingProviderSpecificData,
        apiType: DEFAULT_API_TYPE,
        baseUrl,
        prefix,
        nodeName: name,
        extraApiKeys: apiKeys.slice(1),
        codexNativeCompatible: true,
        fetchStartTimeoutMs: CODEX_EXTERNAL_FETCH_START_TIMEOUT_MS,
        modelAlias: CODEX_EXTERNAL_FIRST_MODEL,
        passthroughModels: true,
        validationModelId: modelId,
      },
      isActive: true,
      testStatus: "unknown",
    };
    const connection = (
      existingConnection
        ? await updateProviderConnection(existingConnection.id, connectionPayload)
        : await createProviderConnection(connectionPayload)
    ) as ProviderConnection;

    const staleConnections = (await getProviderConnections({
      provider: node.id,
    })) as ProviderConnection[];
    await Promise.all(
      staleConnections
        .filter((candidate) => candidate.id !== connection.id && candidate.isActive !== false)
        .map((candidate) => updateProviderConnection(candidate.id, { isActive: false }))
    );

    await upsertCodexExternalFirstCombo(prefix, modelId);

    return NextResponse.json({ upstream: buildStatus(node, connection) }, { status: 201 });
  } catch (error) {
    console.error("[qrouter-upstream] Failed to save upstream config", error);
    return NextResponse.json({ error: "Failed to save QRouter upstream" }, { status: 500 });
  }
}
