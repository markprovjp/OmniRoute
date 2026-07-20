"use client";

import { useState, useEffect, useMemo, useCallback, useRef, memo } from "react";
import {
  Card,
  Button,
  Input,
  Modal,
  ConfirmModal,
  CardSkeleton,
  Toggle,
} from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useTranslations } from "next-intl";
import { getProviderDisplayName } from "@/lib/display/names";
import { PREPAID_TOKEN_PACKAGES, type ApiKeyBillingMode } from "@/shared/constants/apiKeyBilling";

// Constants for validation
const MAX_KEY_NAME_LENGTH = 200;
const MAX_SELECTED_MODELS = 500;

// Debounce hook for search optimization
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Sanitize user input to prevent XSS
function sanitizeInput(input: string): string {
  return input
    .replace(/[<>]/g, "")
    .replace(/"/g, "")
    .replace(/'/g, "")
    .trim()
    .slice(0, MAX_KEY_NAME_LENGTH);
}

function sanitizeNote(input: string): string {
  return input.replace(/[<>]/g, "").trim().slice(0, 2000);
}

function extendExpiryByDays(value: string | null | undefined, days: number): string {
  const current = value ? new Date(value).getTime() : Number.NaN;
  const base = Number.isFinite(current) && current > Date.now() ? current : Date.now();
  return new Date(base + days * 86400_000).toISOString();
}

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${value / 1_000_000_000}B`;
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}K`;
  return String(value);
}

function formatNumberInput(value: number): string {
  return Number.isFinite(value) && value > 0 ? String(Math.floor(value)) : "";
}

function splitIsoDateTime(value: string | null | undefined): { date: string; time: string } {
  if (!value) return { date: "", time: "" };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function combineLocalDateTime(dateValue: string, timeValue: string): string {
  const date = dateValue.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const time = /^\d{2}:\d{2}$/.test(timeValue.trim()) ? timeValue.trim() : "23:59";
  const parsed = new Date(`${date}T${time}:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function addTokenAllowance(
  currentLimit: number | null | undefined,
  currentUsed: number,
  amount: number
): number {
  return Math.max(currentLimit || 0, currentUsed || 0) + amount;
}

// Validate key name
function validateKeyName(
  name: string,
  t: (key: string, values?: Record<string, unknown>) => string
): { valid: boolean; error?: string } {
  if (!name || !name.trim()) {
    return { valid: false, error: t("keyNameRequired") };
  }
  if (name.length > MAX_KEY_NAME_LENGTH) {
    return { valid: false, error: t("keyNameTooLong", { max: MAX_KEY_NAME_LENGTH }) };
  }
  // Allow Unicode letters (accented chars), numbers, spaces, hyphens, underscores
  if (!/^[\p{L}\p{N}_\-\s]+$/u.test(name)) {
    return {
      valid: false,
      error: t("keyNameInvalid"),
    };
  }
  return { valid: true };
}

interface AccessSchedule {
  enabled: boolean;
  from: string;
  until: string;
  days: number[];
  tz: string;
}

interface ApiKey {
  id: string;
  name: string;
  key: string;
  allowedModels: string[] | null;
  allowedConnections: string[] | null;
  noLog?: boolean;
  autoResolve?: boolean;
  isActive?: boolean;
  isBanned?: boolean;
  expiresAt?: string | null;
  maxSessions?: number;
  maxRequestsPerDay?: number | null;
  maxRequestsPerMinute?: number | null;
  accessSchedule?: AccessSchedule | null;
  rateLimits?: Array<{ limit: number; window: number }> | null;
  scopes?: string[];
  customerName?: string | null;
  internalNote?: string | null;
  tokenLimit?: number | null;
  dailyTokenLimit?: number | null;
  hourlyTokenLimit?: number | null;
  tokenUsed?: number;
  commercialKey?: boolean;
  usage?: KeyUsageStats;
  quota?: KeyQuotaSnapshot;
  createdAt: string;
}

interface KeyQuotaWindow {
  tokenLimit: number | null;
  usedTokens: number;
  reservedTokens: number;
  requestLimit: number | null;
  requestCount: number;
  remainingTokens: number | null;
  remainingRequests: number | null;
  resetAt: string;
}

interface KeyQuotaSnapshot {
  day?: KeyQuotaWindow | null;
  hour?: KeyQuotaWindow | null;
}

type KeyStatusFilter = "all" | "active" | "limited" | "disabled" | "banned" | "expired";

interface ProviderConnection {
  id: string;
  name: string;
  provider: string;
  isActive: boolean;
}

interface KeyUsageStats {
  totalRequests: number;
  todayRequests: number;
  hourRequests?: number;
  totalTokens: number;
  todayTokens: number;
  hourTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  lastUsed: string | null;
  estimatedFromWorkspace?: boolean;
}

interface Model {
  id: string;
  owned_by: string;
}

/** Tuple type for models grouped by provider: [providerName, models[]] */
type ProviderGroup = [provider: string, models: Model[]];

type PendingKeyAction = { type: "delete" | "regenerate"; key: ApiKey } | null;

type ActionMenuItem = {
  icon: string;
  label: string;
  tone?: "default" | "danger" | "success" | "warning";
  disabled?: boolean;
  onClick: () => void;
};

function ActionMenu({
  isOpen,
  onToggle,
  onClose,
  items,
  ariaLabel = "Open key actions",
}: {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  items: ActionMenuItem[];
  ariaLabel?: string;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen, onClose]);

  return (
    <div ref={menuRef} className="relative z-50 inline-flex justify-end">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
      >
        <span className="material-symbols-outlined text-[20px]">more_horiz</span>
      </button>
      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-64 overflow-hidden rounded-lg border border-white/10 bg-[#0f141b] text-text-main shadow-2xl ring-1 ring-black/40"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                item.tone === "danger"
                  ? "text-red-500 hover:bg-red-500/10"
                  : item.tone === "success"
                    ? "text-emerald-600 hover:bg-emerald-500/10"
                    : item.tone === "warning"
                      ? "text-amber-600 hover:bg-amber-500/10"
                      : "text-text-main hover:bg-white/5"
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ApiManagerPageClient() {
  const t = useTranslations("apiManager");
  const tc = useTranslations("common");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [allConnections, setAllConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newInternalNote, setNewInternalNote] = useState("");
  const [newBillingMode, setNewBillingMode] = useState<ApiKeyBillingMode>("prepaid");
  const [newTokenLimit, setNewTokenLimit] = useState(String(PREPAID_TOKEN_PACKAGES[0]));
  const [newRequestLimitDaily, setNewRequestLimitDaily] = useState("");
  const [newExpiresAt, setNewExpiresAt] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [searchModel, setSearchModel] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [usageStats, setUsageStats] = useState<Record<string, KeyUsageStats>>({});
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  const [keySearch, setKeySearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<KeyStatusFilter>("all");
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [pendingKeyAction, setPendingKeyAction] = useState<PendingKeyAction>(null);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);

  const { copied, copy } = useCopyToClipboard();
  const maxApiKeyRequests = useMemo(() => {
    const maxRequests = Object.values(usageStats).reduce(
      (max, stats) => Math.max(max, stats.totalRequests || 0),
      0
    );
    return Math.max(1, maxRequests);
  }, [usageStats]);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch("/v1/models");
      if (res.ok) {
        const data = await res.json();
        setAllModels(data.data || []);
      }
    } catch (error) {
      console.log("Error fetching models:", error);
    }
  }, []);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (res.ok) {
        const data = await res.json();
        setAllConnections(data.connections || []);
      }
    } catch (error) {
      console.log("Error fetching connections:", error);
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data = await res.json();
        const loadedKeys: ApiKey[] = data.keys || [];
        setKeys(loadedKeys);
        setUsageStats(
          Object.fromEntries(
            loadedKeys.map((key) => [
              key.id,
              key.usage || {
                totalRequests: 0,
                todayRequests: 0,
                hourRequests: 0,
                totalTokens: 0,
                todayTokens: 0,
                hourTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                lastUsed: null,
              },
            ])
          )
        );
        fetchSessionCounts(loadedKeys);
      }
    } catch (error) {
      console.log("Error fetching keys:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchModels();
    fetchConnections();
  }, [fetchConnections, fetchData, fetchModels]);

  const fetchSessionCounts = async (apiKeys: ApiKey[]) => {
    if (apiKeys.length === 0) {
      setSessionCounts({});
      return;
    }
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      const byApiKeyRaw =
        data && typeof data.byApiKey === "object" && !Array.isArray(data.byApiKey)
          ? data.byApiKey
          : {};
      const normalized: Record<string, number> = {};
      for (const key of apiKeys) {
        const value = byApiKeyRaw[key.id];
        normalized[key.id] =
          typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
      }
      setSessionCounts(normalized);
    } catch (error) {
      console.log("Error fetching session counts:", error);
    }
  };

  const clearPageError = useCallback(() => setPageError(null), []);
  const clearPageNotice = useCallback(() => setPageNotice(null), []);

  const handleCreateKey = async () => {
    // Validate raw input first, then sanitize
    const validation = validateKeyName(newKeyName, t);
    if (!validation.valid) {
      setNameError(validation.error || t("invalidKeyName"));
      return;
    }
    const sanitizedName = sanitizeInput(newKeyName);

    setIsSubmitting(true);
    setNameError(null);
    setCreateError(null);

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sanitizedName,
          customerName: sanitizeInput(newCustomerName || sanitizedName),
          internalNote: newInternalNote.trim() ? sanitizeNote(newInternalNote) : null,
          billingMode: newBillingMode,
          tokenLimit:
            newBillingMode === "prepaid" ? Math.max(0, Math.floor(Number(newTokenLimit))) : null,
          dailyTokenLimit: null,
          hourlyTokenLimit: null,
          maxRequestsPerDay: newRequestLimitDaily.trim()
            ? Math.max(0, Math.floor(Number(newRequestLimitDaily)))
            : null,
          expiresAt: newExpiresAt || null,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setNewCustomerName("");
        setNewInternalNote("");
        setNewBillingMode("prepaid");
        setNewTokenLimit(String(PREPAID_TOKEN_PACKAGES[0]));
        setNewRequestLimitDaily("");
        setNewExpiresAt("");
        setShowAddModal(false);
      } else {
        setCreateError(data.error || t("failedCreateKey"));
      }
    } catch (error) {
      console.error("Error creating key:", error);
      setCreateError(t("failedCreateKeyRetry"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!id || typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      setPageError(t("invalidKeyId"));
      return;
    }

    setIsSubmitting(true);
    clearPageError();

    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        setKeys((prev) => prev.filter((k) => k.id !== id));
      } else {
        const data = await res.json();
        setPageError(data.error || t("failedDeleteKey"));
      }
    } catch (error) {
      console.error("Error deleting key:", error);
      setPageError(t("failedDeleteKeyRetry"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegenerateKey = async (id: string) => {
    if (!id) return;

    setIsSubmitting(true);
    clearPageError();

    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(id)}/regenerate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
      } else {
        setPageError(data.error || t("failedRegenerateKey"));
      }
    } catch (error) {
      console.error("Error regenerating key:", error);
      setPageError(t("failedRegenerateKeyRetry"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmPendingAction = async () => {
    if (!pendingKeyAction) return;

    const action = pendingKeyAction;
    if (action.type === "delete") {
      await handleDeleteKey(action.key.id);
    } else {
      await handleRegenerateKey(action.key.id);
    }
    setPendingKeyAction(null);
  };

  const patchKeySettings = async (key: ApiKey, payload: Record<string, unknown>) => {
    const res = await fetch(`/api/keys/${encodeURIComponent(key.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || t("failedUpdatePermissions"));
    }
  };
  const handleToggleKey = async (key: ApiKey) => {
    setIsSubmitting(true);
    clearPageError();
    try {
      await patchKeySettings(key, { isActive: key.isActive === false });
      await fetchData();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t("failedUpdatePermissions"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenPermissions = (key: ApiKey) => {
    if (!key || !key.id) return;
    setEditingKey(key);
    setShowPermissionsModal(true);
  };

  const handleCopyExistingKey = async (keyId: string) => {
    if (!keyId) return;

    clearPageError();
    clearPageNotice();
    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}/reveal`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setPageError(data?.error || t("cannotRevealKey"));
        return;
      }

      const data = await res.json();
      if (typeof data?.key === "string") {
        const copiedOk = await copy(data.key, `existing_key_${keyId}`);
        if (!copiedOk) setPageError(t("clipboardCopyFailed"));
      }
    } catch (error) {
      console.log("Error copying existing key:", error);
      setPageError(t("cannotCopyKey"));
    }
  };

  const revealKeyForAction = async (keyId: string): Promise<string | null> => {
    const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}/reveal`);
    const data = await res.json().catch(() => null);
    if (!res.ok || typeof data?.key !== "string") {
      setPageError(data?.error || t("cannotReveal"));
      return null;
    }
    return data.key;
  };

  const handleTestExistingKey = async (key: ApiKey) => {
    if (!key?.id) return;

    setTestingKeyId(key.id);
    clearPageError();
    clearPageNotice();
    try {
      const revealedKey = await revealKeyForAction(key.id);
      if (!revealedKey) return;

      const res = await fetch("/v1/models", {
        headers: {
          Authorization: `Bearer ${revealedKey}`,
        },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPageError(
          data?.error?.message || data?.error || t("keyTestFailed", { status: res.status })
        );
        return;
      }

      const modelCount = Array.isArray(data?.data) ? data.data.length : 0;
      setPageNotice(t("keyWorks", { name: key.name, count: modelCount }));
    } catch (error) {
      console.log("Error testing existing key:", error);
      setPageError(t("cannotTestKey"));
    } finally {
      setTestingKeyId(null);
    }
  };

  const handleUpdatePermissions = async (
    name: string,
    allowedModels: string[],
    noLog: boolean,
    allowedConnections: string[],
    autoResolve: boolean,
    isActive: boolean,
    isBanned: boolean,
    expiresAt: string | null,
    customerName: string | null,
    internalNote: string | null,
    tokenLimit: number | null,
    dailyTokenLimit: number | null,
    hourlyTokenLimit: number | null,
    maxRequestsPerDay: number | null,
    maxSessions: number,
    accessSchedule: AccessSchedule | null,
    rateLimits: Array<{ limit: number; window: number }> | null,
    scopes: string[]
  ) => {
    if (!editingKey || !editingKey.id) return;

    const sanitizedName = sanitizeInput(name);

    // Validate models array
    if (!Array.isArray(allowedModels)) {
      return;
    }

    // Limit number of selected models to prevent abuse
    if (allowedModels.length > MAX_SELECTED_MODELS) {
      return;
    }

    // Validate each model ID
    const validModels = allowedModels.filter(
      (id) => typeof id === "string" && id.length > 0 && id.length < 200
    );

    // Validate connections (must be UUIDs)
    const validConnections = allowedConnections.filter(
      (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)
    );
    const normalizedMaxSessions =
      typeof maxSessions === "number" && Number.isFinite(maxSessions)
        ? Math.max(0, Math.floor(maxSessions))
        : 0;

    setIsSubmitting(true);
    clearPageError();

    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(editingKey.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sanitizedName,
          allowedModels: validModels,
          allowedConnections: validConnections,
          noLog,
          autoResolve,
          isActive,
          isBanned,
          expiresAt,
          customerName,
          internalNote,
          tokenLimit,
          dailyTokenLimit,
          hourlyTokenLimit,
          maxRequestsPerDay,
          maxSessions: normalizedMaxSessions,
          accessSchedule,
          rateLimits,
          scopes,
        }),
      });

      if (res.ok) {
        await fetchData();
        setShowPermissionsModal(false);
        setEditingKey(null);
      } else {
        const data = await res.json();
        setPageError(data.error || t("failedUpdatePermissions"));
      }
    } catch (error) {
      console.error("Error updating permissions:", error);
      setPageError(t("failedUpdatePermissionsRetry"));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Debounced search for performance
  const debouncedSearchModel = useDebouncedValue(searchModel, 150);

  // Group models by provider (issue #2021 — use centralized display helper so
  // custom OpenAI-/Anthropic-compatible providers don't leak raw synthetic
  // ids like "openai-compatible-chat-<uuid>" into the grouping label)
  const modelsByProvider = useMemo((): ProviderGroup[] => {
    const grouped: Record<string, Model[]> = {};
    for (const model of allModels) {
      const provider =
        getProviderDisplayName(model.owned_by) || model.owned_by || t("unknownProvider");
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push(model);
    }
    return Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]));
  }, [allModels, t]);

  // Filter models based on debounced search
  const filteredModelsByProvider = useMemo((): ProviderGroup[] => {
    if (!debouncedSearchModel.trim()) return modelsByProvider;

    const search = debouncedSearchModel.toLowerCase();
    return modelsByProvider
      .map(
        ([provider, models]): ProviderGroup => [
          provider,
          models.filter(
            (m) => m.id.toLowerCase().includes(search) || provider.toLowerCase().includes(search)
          ),
        ]
      )
      .filter(([, models]) => models.length > 0);
  }, [modelsByProvider, debouncedSearchModel]);

  const filteredKeys = useMemo(() => {
    const search = keySearch.trim().toLowerCase();
    return keys.filter((key) => {
      const expired = Boolean(key.expiresAt && new Date(key.expiresAt).getTime() < Date.now());
      const limited = Boolean(
        key.tokenLimit || key.dailyTokenLimit || key.hourlyTokenLimit || key.maxRequestsPerDay
      );
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && key.isActive !== false && !key.isBanned && !expired) ||
        (statusFilter === "limited" && limited) ||
        (statusFilter === "disabled" && key.isActive === false) ||
        (statusFilter === "banned" && key.isBanned === true) ||
        (statusFilter === "expired" && expired);
      const haystack = [key.name, key.customerName, key.internalNote, key.key]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesStatus && (!search || haystack.includes(search));
    });
  }, [keys, keySearch, statusFilter]);

  const managerSummary = useMemo(() => {
    const now = Date.now();
    return keys.reduce(
      (summary, key) => {
        const expired = Boolean(key.expiresAt && new Date(key.expiresAt).getTime() < now);
        const usage = usageStats[key.id];
        const hasQuota = Boolean(
          key.tokenLimit || key.dailyTokenLimit || key.hourlyTokenLimit || key.maxRequestsPerDay
        );
        summary.activeKeys += key.isActive === false || key.isBanned || expired ? 0 : 1;
        summary.limitedKeys += hasQuota ? 1 : 0;
        summary.todayRequests += usage?.todayRequests || 0;
        summary.todayTokens += usage?.todayTokens || 0;
        summary.totalTokens += Math.max(key.tokenUsed ?? 0, usage?.totalTokens ?? 0);
        summary.reservedTokens +=
          key.quota?.day?.reservedTokens ?? key.quota?.hour?.reservedTokens ?? 0;
        return summary;
      },
      {
        activeKeys: 0,
        limitedKeys: 0,
        todayRequests: 0,
        todayTokens: 0,
        totalTokens: 0,
        reservedTokens: 0,
      }
    );
  }, [keys, usageStats]);
  const newExpiryDateTime = splitIsoDateTime(newExpiresAt);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Error Banner */}
      {pageError && (
        <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <span className="material-symbols-outlined text-red-500">error</span>
          <p className="text-sm text-red-700 dark:text-red-300 flex-1">{pageError}</p>
          <button
            onClick={clearPageError}
            className="text-red-500 hover:text-red-700 transition-colors"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {pageNotice && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <span className="material-symbols-outlined text-emerald-500">check_circle</span>
          <p className="flex-1 text-sm text-emerald-700 dark:text-emerald-300">{pageNotice}</p>
          <button
            onClick={clearPageNotice}
            className="text-emerald-500 transition-colors hover:text-emerald-700"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {/* Stats Summary Cards */}
      {keys.length > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-9 rounded-lg bg-primary/10">
                <span className="material-symbols-outlined text-primary text-lg">vpn_key</span>
              </div>
              <div>
                <p className="text-2xl font-bold">{keys.length}</p>
                <p className="text-xs text-text-muted">{t("totalKeys")}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-9 rounded-lg bg-amber-500/10">
                <span className="material-symbols-outlined text-amber-500 text-lg">lock</span>
              </div>
              <div>
                <p className="text-2xl font-bold">{managerSummary.activeKeys.toLocaleString()}</p>
                <p className="text-xs text-text-muted">{t("activeShares")}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-9 rounded-lg bg-emerald-500/10">
                <span className="material-symbols-outlined text-emerald-500 text-lg">
                  rule_settings
                </span>
              </div>
              <div>
                <p className="text-2xl font-bold">{managerSummary.limitedKeys.toLocaleString()}</p>
                <p className="text-xs text-text-muted">{t("quotaPlans")}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-9 rounded-lg bg-blue-500/10">
                <span className="material-symbols-outlined text-blue-500 text-lg">bar_chart</span>
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {managerSummary.todayRequests.toLocaleString()}
                </p>
                <p className="text-xs text-text-muted">{t("requestsToday")}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-9 rounded-lg bg-cyan-500/10">
                <span className="material-symbols-outlined text-cyan-500 text-lg">token</span>
              </div>
              <div>
                <p className="text-2xl font-bold">{managerSummary.totalTokens.toLocaleString()}</p>
                <p className="text-xs text-text-muted">{t("totalTokensUsed")}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-9 rounded-lg bg-rose-500/10">
                <span className="material-symbols-outlined text-rose-500 text-lg">
                  pending_actions
                </span>
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {managerSummary.reservedTokens.toLocaleString()}
                </p>
                <p className="text-xs text-text-muted">{t("reservedNow")}</p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Keys List Card */}
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center size-10 rounded-lg bg-amber-500/10 shrink-0">
              <span className="material-symbols-outlined text-xl text-amber-500">vpn_key</span>
            </div>
            <div>
              <h3 className="font-semibold">{t("registeredKeys")}</h3>
              <p className="text-xs text-text-muted">
                {keys.length}{" "}
                {keys.length === 1
                  ? t("keyRegistered", { count: keys.length })
                  : t("keysRegistered", { count: keys.length })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <Button
              icon="add"
              onClick={() => {
                setNameError(null);
                setCreateError(null);
                clearPageError();
                setShowAddModal(true);
              }}
            >
              {t("createKey")}
            </Button>
          </div>
        </div>

        <p className="text-sm text-text-muted mb-4">{t("keysSecurityNote")}</p>

        <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-surface/30 p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-sm">
            <Input
              value={keySearch}
              onChange={(event) => setKeySearch(event.target.value)}
              placeholder={t("searchKeysPlaceholder")}
              icon="search"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["all", t("filterAll")],
                ["active", t("filterActive")],
                ["limited", t("filterLimited")],
                ["disabled", t("filterPaused")],
                ["banned", t("filterBanned")],
                ["expired", t("filterExpired")],
              ] as Array<[KeyStatusFilter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === value
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-text-muted hover:border-primary/40 hover:text-text-main"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {keys.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border rounded-lg">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-2">{t("noKeys")}</p>
            <p className="text-sm text-text-muted mb-4">{t("noKeysDesc")}</p>
            <Button
              icon="add"
              onClick={() => {
                setNameError(null);
                setCreateError(null);
                setShowAddModal(true);
              }}
            >
              {t("createFirstKey")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 overflow-visible lg:gap-0 lg:rounded-lg lg:border lg:border-border">
            {/* Table Header */}
            <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-3 bg-surface/50 border-b border-border text-xs font-semibold text-text-muted uppercase tracking-wider">
              <div className="col-span-2">{t("name")}</div>
              <div className="col-span-2">{t("key")}</div>
              <div className="col-span-2">{t("permissions")}</div>
              <div className="col-span-3">{t("usage")}</div>
              <div className="col-span-1">{t("created")}</div>
              <div className="col-span-2 text-right">{t("actions")}</div>
            </div>

            {/* Table Rows */}
            {filteredKeys.map((key) => {
              const stats = usageStats[key.id];
              const isRestricted = Array.isArray(key.allowedModels) && key.allowedModels.length > 0;
              const hasConnectionRestrictions =
                Array.isArray(key.allowedConnections) && key.allowedConnections.length > 0;
              const noLogEnabled = key.noLog === true;
              const keyIsActive = key.isActive !== false; // default true
              const hasManageScope = Array.isArray(key.scopes) && key.scopes.includes("manage");
              const maxSessions = typeof key.maxSessions === "number" ? key.maxSessions : 0;
              const hasSessionLimit = maxSessions > 0;
              const activeSessions = sessionCounts[key.id] || 0;
              const hasSchedule = key.accessSchedule?.enabled === true;
              const tokenUsed = typeof key.tokenUsed === "number" ? key.tokenUsed : 0;
              const displayTokenUsed = Math.max(tokenUsed, stats?.totalTokens || 0);
              const tokenLimit = typeof key.tokenLimit === "number" ? key.tokenLimit : null;
              const totalRequests = stats?.totalRequests ?? 0;
              const requestLimitDaily =
                typeof key.maxRequestsPerDay === "number" && key.maxRequestsPerDay > 0
                  ? key.maxRequestsPerDay
                  : null;
              const todayRequests = key.quota?.day?.requestCount ?? stats?.todayRequests ?? 0;
              const requestActivityPct = totalRequests
                ? Math.min(100, Math.max(5, (totalRequests / maxApiKeyRequests) * 100))
                : 0;
              const dayTokenLimit =
                typeof key.dailyTokenLimit === "number"
                  ? key.dailyTokenLimit
                  : (key.quota?.day?.tokenLimit ?? null);
              const dayTokenUsed =
                (key.quota?.day?.usedTokens ?? stats?.todayTokens ?? 0) +
                (key.quota?.day?.reservedTokens ?? 0);
              const hourTokenLimit =
                typeof key.hourlyTokenLimit === "number"
                  ? key.hourlyTokenLimit
                  : (key.quota?.hour?.tokenLimit ?? null);
              const hourTokenUsed =
                (key.quota?.hour?.usedTokens ?? stats?.hourTokens ?? 0) +
                (key.quota?.hour?.reservedTokens ?? 0);
              const quotaTotalUsed = Math.max(displayTokenUsed, dayTokenUsed, hourTokenUsed);
              return (
                <div
                  key={key.id}
                  className={`relative grid grid-cols-1 gap-4 rounded-lg border border-border bg-background/90 p-4 shadow-sm transition-colors hover:bg-surface/25 lg:grid-cols-12 lg:gap-4 lg:rounded-none lg:border-x-0 lg:border-t-0 lg:bg-transparent lg:px-4 lg:py-3 lg:shadow-none lg:last:border-b-0 ${
                    openActionMenuId === key.id ? "z-40" : "z-0"
                  }`}
                >
                  <div className="flex items-start gap-2 lg:col-span-2 lg:items-center">
                    <span
                      className={`material-symbols-outlined text-sm ${isRestricted ? "text-amber-500" : "text-emerald-500"}`}
                    >
                      {isRestricted ? "lock" : "lock_open"}
                    </span>
                    <div className="min-w-0">
                      <span className="block text-sm font-medium truncate" title={key.name}>
                        {key.name}
                      </span>
                      <span
                        className="block text-[11px] text-text-muted truncate"
                        title={key.internalNote || key.customerName || ""}
                      >
                        {key.customerName || t("noCustomerName")}
                      </span>
                      <span
                        className={`mt-1 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          key.commercialKey
                            ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                        }`}
                      >
                        {key.commercialKey ? t("sharedKey") : t("systemKey")}
                      </span>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 lg:col-span-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted lg:hidden">
                      {t("key")}
                    </span>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <code className="min-w-0 truncate font-mono text-sm text-text-muted">
                        {key.key}
                      </code>
                      <button
                        onClick={() => handleCopyExistingKey(key.id)}
                        className="shrink-0 rounded-md p-1 text-text-muted/70 transition-colors hover:bg-primary/10 hover:text-primary"
                        title={tc("copy")}
                        aria-label={tc("copy")}
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          {copied === `existing_key_${key.id}` ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center lg:col-span-2">
                    <div className="flex flex-col items-start gap-1">
                      {isRestricted ? (
                        <button
                          onClick={() => handleOpenPermissions(key)}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">lock</span>
                          {t("modelsCount", { count: key.allowedModels.length })}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleOpenPermissions(key)}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 text-xs font-medium hover:bg-green-500/20 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">lock_open</span>
                          {t("allModels")}
                        </button>
                      )}
                      {hasConnectionRestrictions && (
                        <button
                          onClick={() => handleOpenPermissions(key)}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-medium hover:bg-blue-500/20 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">cable</span>
                          {key.allowedConnections.length} conn
                        </button>
                      )}
                      {noLogEnabled && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">
                            visibility_off
                          </span>
                          No-Log
                        </span>
                      )}
                      {key.autoResolve && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">
                            auto_fix_high
                          </span>
                          Auto-Resolve
                        </span>
                      )}
                      {hasSessionLimit && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">group</span>
                          Sessions: {activeSessions}/{maxSessions}
                        </span>
                      )}
                      {hasManageScope && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">
                            admin_panel_settings
                          </span>
                          manage
                        </span>
                      )}
                      {!keyIsActive && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-500/10 text-red-600 dark:text-red-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">block</span>
                          {t("disabled")}
                        </span>
                      )}
                      {hasSchedule && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">schedule</span>
                          {t("scheduleActive")}
                        </span>
                      )}
                      {key.isBanned && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-600/10 text-red-700 dark:text-red-400 text-[11px] font-bold animate-pulse">
                          <span className="material-symbols-outlined text-[12px]">gavel</span>
                          BANNED
                        </span>
                      )}
                      {key.expiresAt && new Date(key.expiresAt).getTime() < Date.now() && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-500/10 text-gray-600 dark:text-gray-400 text-[11px] font-medium">
                          <span className="material-symbols-outlined text-[12px]">event_busy</span>
                          EXPIRED
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-surface/30 p-2 lg:col-span-3 lg:border-0 lg:bg-transparent lg:p-0">
                    <div className="flex items-center justify-between gap-2 text-[10px] font-semibold text-text-main tabular-nums">
                      <span>{t("totalQuotaUsed")}</span>
                      <span>{quotaTotalUsed.toLocaleString()} tokens</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium tabular-nums">
                        {stats?.totalRequests ?? 0}{" "}
                        <span className="text-text-muted font-normal text-xs">{t("reqs")}</span>
                      </span>
                      {stats?.lastUsed ? (
                        <span className="text-[10px] text-text-muted">
                          {t("lastUsedOn", { date: new Date(stats.lastUsed).toLocaleDateString() })}
                        </span>
                      ) : (
                        <span className="text-[10px] text-text-muted italic">{t("neverUsed")}</span>
                      )}
                    </div>
                    {requestLimitDaily && (
                      <div className="flex flex-col gap-1 w-full mt-0.5">
                        <div className="flex items-center justify-between text-[10px] text-text-muted tabular-nums">
                          <span>
                            {todayRequests.toLocaleString()} / {requestLimitDaily.toLocaleString()}{" "}
                            req today
                          </span>
                          <span>
                            {Math.max(0, requestLimitDaily - todayRequests).toLocaleString()} left
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-500 transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.max(0, (todayRequests / requestLimitDaily) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {dayTokenLimit && (
                      <div className="flex flex-col gap-1 w-full mt-0.5">
                        <div className="flex items-center justify-between text-[10px] text-text-muted tabular-nums">
                          <span>
                            Day tokens {dayTokenUsed.toLocaleString()} /{" "}
                            {dayTokenLimit.toLocaleString()}
                          </span>
                          <span>
                            {Math.max(0, dayTokenLimit - dayTokenUsed).toLocaleString()} left
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-300"
                            style={{
                              width: `${Math.min(100, (dayTokenUsed / dayTokenLimit) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {hourTokenLimit && (
                      <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted tabular-nums">
                        <span>Hour tokens {hourTokenUsed.toLocaleString()}</span>
                        <span>Limit {hourTokenLimit.toLocaleString()}</span>
                      </div>
                    )}
                    {tokenLimit ? (
                      (() => {
                        const pct = Math.min(
                          100,
                          Math.max(0, (displayTokenUsed / tokenLimit) * 100)
                        );
                        const remaining = Math.max(0, tokenLimit - displayTokenUsed);
                        return (
                          <div className="flex flex-col gap-1 w-full mt-0.5">
                            <div className="flex items-center justify-between text-[10px] text-text-muted tabular-nums">
                              <span>
                                {displayTokenUsed.toLocaleString()} / {tokenLimit.toLocaleString()}{" "}
                                tokens
                              </span>
                              <span>{remaining.toLocaleString()} remaining</span>
                            </div>
                            <div className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  pct < 70
                                    ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                                    : pct < 100
                                      ? "bg-gradient-to-r from-amber-500 to-orange-500"
                                      : "bg-gradient-to-r from-red-500 to-rose-500"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[9px] text-text-muted/60 italic leading-none">
                              * (In + Out combined)
                            </span>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="flex flex-col gap-1 w-full mt-0.5">
                        <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted tabular-nums">
                          <span>{displayTokenUsed.toLocaleString()} tokens used</span>
                          <span>{totalRequests.toLocaleString()} req total</span>
                        </div>
                        <div className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-500 transition-all duration-300"
                            style={{ width: `${requestActivityPct}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-text-muted/60 italic leading-none">
                          {stats?.estimatedFromWorkspace
                            ? t("unlimitedQuotaHistorical")
                            : t("unlimitedQuotaMeasured")}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col justify-center text-sm text-text-muted lg:col-span-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted lg:hidden">
                      {t("created")}
                    </span>
                    <span>{new Date(key.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center justify-end lg:col-span-2">
                    <ActionMenu
                      isOpen={openActionMenuId === key.id}
                      onToggle={() =>
                        setOpenActionMenuId((current) => (current === key.id ? null : key.id))
                      }
                      onClose={() => setOpenActionMenuId(null)}
                      items={[
                        {
                          icon: copied === `existing_key_${key.id}` ? "check" : "content_copy",
                          label: copied === `existing_key_${key.id}` ? tc("copied") : tc("copy"),
                          onClick: () => handleCopyExistingKey(key.id),
                        },
                        {
                          icon: testingKeyId === key.id ? "progress_activity" : "network_check",
                          label: testingKeyId === key.id ? t("testingKey") : t("testKey"),
                          disabled: testingKeyId === key.id,
                          onClick: () => handleTestExistingKey(key),
                        },
                        {
                          icon: keyIsActive ? "pause_circle" : "play_circle",
                          label: keyIsActive ? t("disableKey") : t("enableKey"),
                          tone: keyIsActive ? "warning" : "success",
                          onClick: () => handleToggleKey(key),
                        },
                        {
                          icon: "add_circle",
                          label: t("addTokensQuota"),
                          onClick: () => handleOpenPermissions(key),
                        },
                        {
                          icon: "tune",
                          label: t("editPermissions"),
                          onClick: () => handleOpenPermissions(key),
                        },
                        {
                          icon: "refresh",
                          label: t("regenerateKey"),
                          tone: "warning",
                          onClick: () => setPendingKeyAction({ type: "regenerate", key }),
                        },
                        {
                          icon: "delete",
                          label: t("deleteKey"),
                          tone: "danger",
                          onClick: () => setPendingKeyAction({ type: "delete", key }),
                        },
                      ]}
                      ariaLabel={t("keyActions")}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title={t("createKey")}
        size="full"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
          setNewCustomerName("");
          setNewInternalNote("");
          setNewBillingMode("prepaid");
          setNewTokenLimit(String(PREPAID_TOKEN_PACKAGES[0]));
          setNewRequestLimitDaily("");
          setNewExpiresAt("");
          setNameError(null);
          setCreateError(null);
        }}
      >
        <div className="flex flex-col gap-5">
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("keyName")}
            </label>
            <Input
              value={newKeyName}
              onChange={(e) => {
                setNewKeyName(e.target.value);
                setNameError(null);
              }}
              placeholder={t("keyNamePlaceholder")}
              maxLength={MAX_KEY_NAME_LENGTH}
              error={nameError}
              autoFocus
            />
            <p className="text-xs text-text-muted mt-1.5">{t("keyNameDesc")}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-text-main mb-1.5 block">
                {t("customerName")}
              </label>
              <Input
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
                placeholder={t("customerOrCompany")}
                maxLength={MAX_KEY_NAME_LENGTH}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-sm font-medium text-text-main mb-1.5 block">
                {t("keyType")}
              </label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("keyType")}>
                {[
                  {
                    value: "prepaid" as const,
                    icon: "payments",
                    label: t("prepaidTokenKey"),
                    description: t("prepaidTokenKeyDesc"),
                  },
                  {
                    value: "system" as const,
                    icon: "admin_panel_settings",
                    label: t("systemKey"),
                    description: t("systemKeyDesc"),
                  },
                ].map((option) => {
                  const selected = newBillingMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setNewBillingMode(option.value);
                        setNewTokenLimit(
                          option.value === "prepaid" ? String(PREPAID_TOKEN_PACKAGES[0]) : ""
                        );
                      }}
                      className={`flex min-h-24 items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        selected
                          ? "border-primary bg-primary/10 text-text-main"
                          : "border-border bg-surface/30 text-text-muted hover:border-primary/40"
                      }`}
                    >
                      <span className="material-symbols-outlined mt-0.5 text-lg">
                        {option.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{option.label}</span>
                        <span className="mt-1 block text-xs leading-5">{option.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            {newBillingMode === "prepaid" && (
              <div className="sm:col-span-2">
                <label className="text-sm font-medium text-text-main mb-1.5 block">
                  {t("tokenPackage")}
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                  {PREPAID_TOKEN_PACKAGES.map((amount) => {
                    const selected = Number(newTokenLimit) === amount;
                    return (
                      <button
                        key={amount}
                        type="button"
                        onClick={() => setNewTokenLimit(String(amount))}
                        className={`min-h-11 rounded-md border px-2 py-2 text-sm font-semibold tabular-nums transition-colors ${
                          selected
                            ? "border-primary bg-primary text-white"
                            : "border-border bg-surface/30 text-text-muted hover:border-primary/40 hover:text-primary"
                        }`}
                      >
                        {formatCompactTokens(amount)}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-text-muted">{t("tokenUsageCombinedDesc")}</p>
              </div>
            )}
            <div>
              <label className="text-sm font-medium text-text-main mb-1.5 block">
                {t("requestsPerDay")}
              </label>
              <Input
                value={newRequestLimitDaily}
                onChange={(e) => setNewRequestLimitDaily(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder={t("unlimited")}
                inputMode="numeric"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("internalNote")}
            </label>
            <textarea
              value={newInternalNote}
              onChange={(e) => setNewInternalNote(e.target.value)}
              placeholder={t("operatorOnly")}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-text-main"
            />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <label className="text-sm font-medium text-text-main">{t("expiry")}</label>
                <p className="text-xs text-text-muted">{t("optionalBlankNoExpire")}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[7, 30, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setNewExpiresAt(extendExpiryByDays(newExpiresAt, days))}
                    className="rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
                  >
                    +{days}d
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setNewExpiresAt("")}
                  className="rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-red-500/40 hover:text-red-500"
                >
                  {t("clear")}
                </button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                type="date"
                value={newExpiryDateTime.date}
                onChange={(e) =>
                  setNewExpiresAt(combineLocalDateTime(e.target.value, newExpiryDateTime.time))
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-main"
              />
              <input
                type="time"
                value={newExpiryDateTime.time}
                onChange={(e) =>
                  setNewExpiresAt(combineLocalDateTime(newExpiryDateTime.date, e.target.value))
                }
                disabled={!newExpiryDateTime.date}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-main disabled:opacity-50"
              />
            </div>
          </div>
          {createError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
              <span className="material-symbols-outlined text-red-500 text-sm">error</span>
              <p className="text-sm text-red-700 dark:text-red-300 flex-1">{createError}</p>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
                setNewCustomerName("");
                setNewInternalNote("");
                setNewBillingMode("prepaid");
                setNewTokenLimit(String(PREPAID_TOKEN_PACKAGES[0]));
                setNewRequestLimitDaily("");
                setNewExpiresAt("");
                setNameError(null);
                setCreateError(null);
              }}
              variant="ghost"
              fullWidth
            >
              {tc("cancel")}
            </Button>
            <Button
              onClick={handleCreateKey}
              fullWidth
              disabled={!newKeyName.trim()}
              loading={isSubmitting}
            >
              {t("createKey")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal isOpen={!!createdKey} title={t("keyCreated")} onClose={() => setCreatedKey(null)}>
        <div className="flex flex-col gap-4">
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-green-600 dark:text-green-400">
                check_circle
              </span>
              <div>
                <p className="text-sm text-green-800 dark:text-green-200 font-medium mb-1">
                  {t("keyCreatedSuccess")}
                </p>
                <p className="text-sm text-green-700 dark:text-green-300">{t("keyCreatedNote")}</p>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Input value={createdKey || ""} readOnly className="flex-1 font-mono text-sm" />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? tc("copied") : tc("copy")}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            {t("done")}
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={pendingKeyAction !== null}
        onClose={() => setPendingKeyAction(null)}
        onConfirm={handleConfirmPendingAction}
        title={pendingKeyAction?.type === "delete" ? t("deleteKey") : t("regenerateKey")}
        message={pendingKeyAction?.type === "delete" ? t("deleteConfirm") : t("regenerateConfirm")}
        confirmText={pendingKeyAction?.type === "delete" ? t("deleteKey") : t("regenerateKey")}
        cancelText={tc("cancel")}
        variant={pendingKeyAction?.type === "delete" ? "danger" : "primary"}
        loading={isSubmitting}
      />

      {/* Permissions Modal */}
      {editingKey && (
        <PermissionsModal
          key={editingKey.id}
          isOpen={showPermissionsModal}
          onClose={() => {
            setShowPermissionsModal(false);
            setEditingKey(null);
          }}
          apiKey={editingKey}
          modelsByProvider={filteredModelsByProvider}
          allModels={allModels}
          allConnections={allConnections}
          searchModel={searchModel}
          onSearchChange={setSearchModel}
          onSave={handleUpdatePermissions}
        />
      )}
    </div>
  );
}

// -- Permissions Modal Component (Memoized for Performance) ------------------------------------------

const PermissionsModal = memo(function PermissionsModal({
  isOpen,
  onClose,
  apiKey,
  modelsByProvider,
  allModels,
  allConnections,
  searchModel,
  onSearchChange,
  onSave,
}: {
  isOpen: boolean;
  onClose: () => void;
  apiKey: ApiKey;
  modelsByProvider: ProviderGroup[];
  allModels: Model[];
  allConnections: ProviderConnection[];
  searchModel: string;
  onSearchChange: (v: string) => void;
  onSave: (
    name: string,
    models: string[],
    noLog: boolean,
    connections: string[],
    autoResolve: boolean,
    isActive: boolean,
    isBanned: boolean,
    expiresAt: string | null,
    customerName: string | null,
    internalNote: string | null,
    tokenLimit: number | null,
    dailyTokenLimit: number | null,
    hourlyTokenLimit: number | null,
    maxRequestsPerDay: number | null,
    maxSessions: number,
    accessSchedule: AccessSchedule | null,
    rateLimits: Array<{ limit: number; window: number }> | null,
    scopes: string[]
  ) => void;
}) {
  const t = useTranslations("apiManager");
  const tc = useTranslations("common");

  // Initialize state from props - component remounts when key prop changes
  const initialModels = Array.isArray(apiKey?.allowedModels) ? apiKey.allowedModels : [];
  const initialConnections = Array.isArray(apiKey?.allowedConnections)
    ? apiKey.allowedConnections
    : [];
  const [keyName, setKeyName] = useState(apiKey?.name ?? "");
  const [selectedModels, setSelectedModels] = useState<string[]>(initialModels);
  const [allowAll, setAllowAll] = useState(initialModels.length === 0);
  const [noLogEnabled, setNoLogEnabled] = useState(apiKey?.noLog === true);
  const [autoResolveEnabled, setAutoResolveEnabled] = useState(apiKey?.autoResolve === true);
  const [keyIsActive, setKeyIsActive] = useState(apiKey?.isActive !== false);
  const [keyIsBanned, setKeyIsBanned] = useState(apiKey?.isBanned === true);
  const [expiresAt, setExpiresAt] = useState(apiKey?.expiresAt ?? "");
  const [customerName, setCustomerName] = useState(apiKey?.customerName ?? "");
  const [internalNote, setInternalNote] = useState(apiKey?.internalNote ?? "");
  const [tokenLimit, setTokenLimit] = useState(
    typeof apiKey?.tokenLimit === "number" && apiKey.tokenLimit > 0 ? String(apiKey.tokenLimit) : ""
  );
  const [dailyTokenLimit, setDailyTokenLimit] = useState(
    typeof apiKey?.dailyTokenLimit === "number" && apiKey.dailyTokenLimit > 0
      ? String(apiKey.dailyTokenLimit)
      : ""
  );
  const [hourlyTokenLimit, setHourlyTokenLimit] = useState(
    typeof apiKey?.hourlyTokenLimit === "number" && apiKey.hourlyTokenLimit > 0
      ? String(apiKey.hourlyTokenLimit)
      : ""
  );
  const [requestLimitDaily, setRequestLimitDaily] = useState(
    typeof apiKey?.maxRequestsPerDay === "number" && apiKey.maxRequestsPerDay > 0
      ? String(apiKey.maxRequestsPerDay)
      : ""
  );
  const [manageEnabled, setManageEnabled] = useState(
    Array.isArray(apiKey?.scopes) && apiKey.scopes.includes("manage")
  );
  const [maxSessions, setMaxSessions] = useState(
    typeof apiKey?.maxSessions === "number" && apiKey.maxSessions > 0 ? apiKey.maxSessions : 0
  );
  const [scheduleEnabled, setScheduleEnabled] = useState(apiKey?.accessSchedule?.enabled === true);
  const [scheduleFrom, setScheduleFrom] = useState(apiKey?.accessSchedule?.from ?? "08:00");
  const [scheduleUntil, setScheduleUntil] = useState(apiKey?.accessSchedule?.until ?? "18:00");
  const [scheduleDays, setScheduleDays] = useState<number[]>(
    apiKey?.accessSchedule?.days ?? [1, 2, 3, 4, 5]
  );
  const [scheduleTz, setScheduleTz] = useState(
    apiKey?.accessSchedule?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [rateLimits, setRateLimits] = useState<Array<{ limit: number; window: number }>>(
    Array.isArray(apiKey?.rateLimits) ? apiKey.rateLimits : []
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedConnections, setSelectedConnections] = useState<string[]>(initialConnections);
  const [allowAllConnections, setAllowAllConnections] = useState(initialConnections.length === 0);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(() => {
    // Expand all providers by default when in restrict mode with existing selections
    if (initialModels.length > 0) {
      return new Set(modelsByProvider.map(([p]) => p));
    }
    return new Set();
  });

  // Memoize callbacks to prevent child re-renders
  const handleToggleModel = useCallback(
    (modelId: string) => {
      if (allowAll) return;

      setSelectedModels((prev) => {
        if (prev.includes(modelId)) {
          return prev.filter((m) => m !== modelId);
        }
        return [...prev, modelId];
      });
    },
    [allowAll]
  );

  const handleToggleProvider = useCallback(
    (provider: string, models: Model[]) => {
      if (allowAll) return;

      const modelIds = models.map((m) => m.id);
      setSelectedModels((prev) => {
        const allSelected = modelIds.every((id) => prev.includes(id));
        if (allSelected) {
          return prev.filter((m) => !modelIds.includes(m));
        }
        return [...new Set([...prev, ...modelIds])];
      });
    },
    [allowAll]
  );

  const handleSelectAll = useCallback(() => {
    setAllowAll(true);
    setSelectedModels([]);
  }, []);

  const handleRestrictMode = useCallback(() => {
    setAllowAll(false);
    // Expand all providers when entering restrict mode
    const allProviders = new Set(modelsByProvider.map(([p]) => p));
    setExpandedProviders(allProviders);
  }, [modelsByProvider]);

  const handleToggleExpand = useCallback((provider: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  }, []);

  const handleSelectAllModels = useCallback(() => {
    const allModelIds = allModels.map((m) => m.id);
    setSelectedModels(allModelIds);
  }, [allModels]);

  const handleDeselectAllModels = useCallback(() => {
    setSelectedModels([]);
  }, []);

  const handleToggleConnection = useCallback(
    (connectionId: string) => {
      if (allowAllConnections) return;
      setSelectedConnections((prev) =>
        prev.includes(connectionId)
          ? prev.filter((c) => c !== connectionId)
          : [...prev, connectionId]
      );
    },
    [allowAllConnections]
  );

  const handleSave = useCallback(() => {
    // Clear previous inline errors
    setNameError(null);
    setSaveError(null);

    // Validate name inline before calling onSave
    const validation = validateKeyName(keyName, t);
    if (!validation.valid) {
      setNameError(validation.error || t("invalidKeyName"));
      return;
    }

    // Validate models selection
    if (!allowAll && !Array.isArray(selectedModels)) {
      setSaveError(t("invalidModelsSelection"));
      return;
    }

    // Limit number of selected models to prevent abuse
    if (!allowAll && selectedModels.length > MAX_SELECTED_MODELS) {
      setSaveError(t("cannotSelectMoreThanModels", { max: MAX_SELECTED_MODELS }));
      return;
    }

    const schedule: AccessSchedule | null = scheduleEnabled
      ? {
          enabled: true,
          from: scheduleFrom,
          until: scheduleUntil,
          days: scheduleDays,
          tz: scheduleTz,
        }
      : null;
    onSave(
      keyName,
      allowAll ? [] : selectedModels,
      noLogEnabled,
      allowAllConnections ? [] : selectedConnections,
      autoResolveEnabled,
      keyIsActive,
      keyIsBanned,
      expiresAt || null,
      customerName.trim() ? sanitizeInput(customerName) : null,
      internalNote.trim() ? sanitizeNote(internalNote) : null,
      tokenLimit.trim() ? Math.max(0, Math.floor(Number(tokenLimit))) : null,
      dailyTokenLimit.trim() ? Math.max(0, Math.floor(Number(dailyTokenLimit))) : null,
      hourlyTokenLimit.trim() ? Math.max(0, Math.floor(Number(hourlyTokenLimit))) : null,
      requestLimitDaily.trim() ? Math.max(0, Math.floor(Number(requestLimitDaily))) : null,
      maxSessions,
      schedule,
      rateLimits.length > 0 ? rateLimits : null,
      manageEnabled ? ["manage"] : []
    );
  }, [
    onSave,
    keyName,
    allowAll,
    selectedModels,
    noLogEnabled,
    allowAllConnections,
    selectedConnections,
    autoResolveEnabled,
    keyIsActive,
    keyIsBanned,
    expiresAt,
    customerName,
    internalNote,
    tokenLimit,
    dailyTokenLimit,
    hourlyTokenLimit,
    requestLimitDaily,
    maxSessions,
    manageEnabled,
    scheduleEnabled,
    scheduleFrom,
    scheduleUntil,
    scheduleDays,
    scheduleTz,
    rateLimits,
    t,
  ]);

  const selectedCount = selectedModels.length;
  const totalModels = allModels.length;
  const totalTokenUsed = Math.max(apiKey.tokenUsed ?? 0, apiKey.usage?.totalTokens ?? 0);
  const dayTokenUsed =
    (apiKey.quota?.day?.usedTokens ?? apiKey.usage?.todayTokens ?? 0) +
    (apiKey.quota?.day?.reservedTokens ?? 0);
  const hourTokenUsed =
    (apiKey.quota?.hour?.usedTokens ?? apiKey.usage?.hourTokens ?? 0) +
    (apiKey.quota?.hour?.reservedTokens ?? 0);
  const expiryDateTime = splitIsoDateTime(expiresAt);

  return (
    <Modal
      isOpen={onClose ? isOpen : false}
      title={t("permissionsTitle", { name: apiKey?.name || "" })}
      onClose={onClose}
      size="full"
    >
      <div className="flex flex-col gap-4">
        {/* Key Name */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-main">{t("keyName")}</p>
            <p className="mt-1 text-xs text-text-muted">{t("keyNameDesc")}</p>
          </div>
          <div className="w-full sm:w-72 sm:shrink-0">
            <Input
              value={keyName}
              onChange={(e) => {
                setKeyName(e.target.value);
                setNameError(null);
              }}
              placeholder={t("keyNamePlaceholder")}
              maxLength={MAX_KEY_NAME_LENGTH}
              error={nameError}
            />
          </div>
        </div>

        {/* Inline save error */}
        {saveError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <span className="material-symbols-outlined text-red-500 text-sm">error</span>
            <p className="text-sm text-red-700 dark:text-red-300 flex-1">{saveError}</p>
          </div>
        )}

        {/* Access Mode Toggle */}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1">
          <button
            onClick={handleSelectAll}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              allowAll
                ? "bg-primary text-white"
                : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">lock_open</span>
            {t("allowAll")}
          </button>
          <button
            onClick={handleRestrictMode}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              !allowAll
                ? "bg-primary text-white"
                : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">lock</span>
            {t("restrict")}
          </button>
        </div>

        {/* Info Banner */}
        <div
          className={`flex items-start gap-2 p-3 rounded-lg ${
            allowAll
              ? "bg-green-500/10 border border-green-500/30"
              : "bg-amber-500/10 border border-amber-500/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[18px] ${
              allowAll ? "text-green-500" : "text-amber-500"
            }`}
          >
            {allowAll ? "info" : "warning"}
          </span>
          <p
            className={`text-xs ${
              allowAll ? "text-green-700 dark:text-green-300" : "text-amber-700 dark:text-amber-300"
            }`}
          >
            {allowAll ? t("allowAllDesc") : t("restrictDesc", { selectedCount, totalModels })}
          </p>
        </div>

        {/* Key Active Toggle */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-main">{t("keyActive")}</p>
            <p className="text-xs text-text-muted">{t("keyActiveDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={keyIsActive}
            onClick={() => setKeyIsActive((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              keyIsActive
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                : "bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">
              {keyIsActive ? "check_circle" : "block"}
            </span>
            {keyIsActive ? tc("enabled") : tc("disabled")}
          </button>
        </div>

        {/* Max Sessions Limit (T08) */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-main">{t("maxActiveSessions")}</p>
            <p className="text-xs text-text-muted">{t("maxSessionsDescription")}</p>
          </div>
          <div className="w-full sm:w-32 sm:shrink-0">
            <Input
              type="number"
              min={0}
              step={1}
              value={String(maxSessions)}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value || "0", 10);
                setMaxSessions(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
              }}
            />
          </div>
        </div>

        {/* Custom Rate Limits */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-surface/40">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-main">
                {t("apiManagerCustomRateLimits")}
              </p>
              <p className="text-xs text-text-muted">{t("apiManagerCustomRateLimitsDesc")}</p>
            </div>
            <button
              type="button"
              onClick={() => setRateLimits((prev) => [...prev, { limit: 100, window: 60 }])}
              className="inline-flex w-fit items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 sm:shrink-0"
            >
              <span className="material-symbols-outlined text-[14px]">add</span>
              {t("addLimit")}
            </button>
          </div>
          {rateLimits.length > 0 && (
            <div className="flex flex-col gap-2 pt-2">
              {rateLimits.map((rl, index) => (
                <div
                  key={index}
                  className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_auto] sm:items-center"
                >
                  <Input
                    type="number"
                    min={1}
                    value={String(rl.limit)}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 0;
                      setRateLimits((prev) => {
                        const next = [...prev];
                        next[index].limit = val;
                        return next;
                      });
                    }}
                    placeholder={t("apiManagerRateLimitRequestsPlaceholder")}
                  />
                  <span className="text-sm text-text-muted shrink-0">
                    {t("apiManagerRateLimitReqPer")}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    value={String(rl.window)}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 0;
                      setRateLimits((prev) => {
                        const next = [...prev];
                        next[index].window = val;
                        return next;
                      });
                    }}
                    placeholder={t("apiManagerRateLimitSecondsPlaceholder")}
                  />
                  <span className="text-sm text-text-muted shrink-0">{t("seconds")}</span>
                  <button
                    type="button"
                    onClick={() => setRateLimits((prev) => prev.filter((_, i) => i !== index))}
                    className="p-2 text-red-500 hover:bg-red-500/10 rounded transition-colors shrink-0"
                    title={t("apiManagerRemoveLimitTitle")}
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Access Schedule */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-surface/40">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-main">{t("accessSchedule")}</p>
              <p className="text-xs text-text-muted">{t("accessScheduleDesc")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={scheduleEnabled}
              onClick={() => setScheduleEnabled((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors shrink-0 ${
                scheduleEnabled
                  ? "bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-500/30"
                  : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">schedule</span>
              {scheduleEnabled ? tc("enabled") : tc("disabled")}
            </button>
          </div>
          {scheduleEnabled && (
            <div className="flex flex-col gap-3 pt-1">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t("scheduleFrom")}</label>
                  <input
                    type="time"
                    value={scheduleFrom}
                    onChange={(e) => setScheduleFrom(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background text-text-main"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t("scheduleUntil")}</label>
                  <input
                    type="time"
                    value={scheduleUntil}
                    onChange={(e) => setScheduleUntil(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background text-text-main"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1.5 block">{t("scheduleDays")}</label>
                <div className="flex gap-1 flex-wrap">
                  {(
                    [
                      [0, t("daySun")],
                      [1, t("dayMon")],
                      [2, t("dayTue")],
                      [3, t("dayWed")],
                      [4, t("dayThu")],
                      [5, t("dayFri")],
                      [6, t("daySat")],
                    ] as [number, string][]
                  ).map(([dayIdx, label]) => {
                    const selected = scheduleDays.includes(dayIdx);
                    return (
                      <button
                        key={dayIdx}
                        type="button"
                        onClick={() =>
                          setScheduleDays((prev) =>
                            prev.includes(dayIdx)
                              ? prev.filter((d) => d !== dayIdx)
                              : [...prev, dayIdx].sort((a, b) => a - b)
                          )
                        }
                        className={`px-2 py-1 text-[11px] font-medium rounded transition-all ${
                          selected
                            ? "bg-primary text-white"
                            : "bg-surface border border-border text-text-muted hover:border-primary/50"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">
                  {t("scheduleTimezone")}
                </label>
                <input
                  type="text"
                  value={scheduleTz}
                  onChange={(e) => setScheduleTz(e.target.value)}
                  placeholder={t("apiManagerTimezonePlaceholder")}
                  className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background text-text-main font-mono"
                />
                <p className="text-[10px] text-text-muted mt-1">{t("scheduleTimezoneHint")}</p>
              </div>
            </div>
          )}
        </div>

        {/* Privacy Toggle */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-main">{t("noLogPayloadPrivacy")}</p>
            <p className="text-xs text-text-muted">{t("disablePayloadPersistence")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={noLogEnabled}
            onClick={() => setNoLogEnabled((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              noLogEnabled
                ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30"
                : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">
              {noLogEnabled ? "visibility_off" : "visibility"}
            </span>
            {noLogEnabled ? tc("enabled") : tc("disabled")}
          </button>
        </div>

        {/* Auto-Resolve Toggle */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-main">{t("autoResolve")}</p>
            <p className="text-xs text-text-muted">{t("autoResolveDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoResolveEnabled}
            onClick={() => setAutoResolveEnabled((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              autoResolveEnabled
                ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30"
                : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">
              {autoResolveEnabled ? "auto_fix_high" : "auto_fix_normal"}
            </span>
            {autoResolveEnabled ? tc("enabled") : tc("disabled")}
          </button>
        </div>

        {/* Ban Toggle (SECURITY) */}
        <div className="flex flex-col gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-red-700 dark:text-red-400">{t("bannedStatus")}</p>
            <p className="text-xs text-red-600 dark:text-red-300">{t("bannedDescription")}</p>
          </div>
          <button
            role="switch"
            aria-checked={keyIsBanned}
            onClick={() => setKeyIsBanned((prev) => !prev)}
            className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-bold transition-colors ${
              keyIsBanned
                ? "bg-red-500 text-white shadow-sm"
                : "bg-black/5 dark:bg-white/5 text-text-muted hover:bg-black/10 dark:hover:bg-white/10"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">
              {keyIsBanned ? "block" : "check_circle"}
            </span>
            {keyIsBanned ? t("banned") : t("active")}
          </button>
        </div>
        {/* Customer details */}
        <div className="grid gap-3 p-3 rounded-lg border border-border bg-surface/40 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("customerName")}
            </label>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t("customerOrCompany")}
              maxLength={MAX_KEY_NAME_LENGTH}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("lifetimeTokens")}
            </label>
            <Input
              value={tokenLimit}
              onChange={(e) => setTokenLimit(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={t("unlimited")}
              inputMode="numeric"
            />
            <p className="text-xs text-text-muted mt-1">
              {t("usedTokens", { count: totalTokenUsed.toLocaleString() })}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {PREPAID_TOKEN_PACKAGES.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() =>
                    setTokenLimit(
                      formatNumberInput(
                        addTokenAllowance(Number(tokenLimit || 0), totalTokenUsed, amount)
                      )
                    )
                  }
                  className="rounded-md border border-border px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
                >
                  +{formatCompactTokens(amount)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("tokensPerDay")}
            </label>
            <Input
              value={dailyTokenLimit}
              onChange={(e) => setDailyTokenLimit(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={t("unlimited")}
              inputMode="numeric"
            />
            <p className="text-xs text-text-muted mt-1">
              {t("usedTodayTokens", { count: dayTokenUsed.toLocaleString() })}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {[50_000_000, 100_000_000].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() =>
                    setDailyTokenLimit(
                      formatNumberInput(
                        addTokenAllowance(Number(dailyTokenLimit || 0), dayTokenUsed, amount)
                      )
                    )
                  }
                  className="rounded-md border border-border px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
                >
                  +{formatCompactTokens(amount)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("tokensPerHour")}
            </label>
            <Input
              value={hourlyTokenLimit}
              onChange={(e) => setHourlyTokenLimit(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={t("unlimited")}
              inputMode="numeric"
            />
            <p className="text-xs text-text-muted mt-1">
              {t("usedThisHourTokens", { count: hourTokenUsed.toLocaleString() })}
            </p>
          </div>
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("requestsPerDay")}
            </label>
            <Input
              value={requestLimitDaily}
              onChange={(e) => setRequestLimitDaily(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={t("unlimited")}
              inputMode="numeric"
            />
            <p className="text-xs text-text-muted mt-1">{t("dailyRequestWindow")}</p>
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium text-text-main mb-1.5 block">
              {t("internalNote")}
            </label>
            <textarea
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              placeholder={t("operatorNote")}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background text-text-main"
            />
          </div>
        </div>

        {/* Expiration Date */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-surface/40">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text-main">{t("expirationDate")}</p>
              <p className="text-xs text-text-muted">{t("expirationAutoStop")}</p>
            </div>
            <div className="flex items-center gap-1">
              {[1, 3, 7].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setExpiresAt(extendExpiryByDays(expiresAt, days))}
                  className="px-2 py-1 text-xs rounded-md border border-border text-text-muted hover:text-primary hover:border-primary/40"
                >
                  +{days}d
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              type="date"
              value={expiryDateTime.date}
              onChange={(e) =>
                setExpiresAt(combineLocalDateTime(e.target.value, expiryDateTime.time))
              }
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-main"
            />
            <input
              type="time"
              value={expiryDateTime.time}
              onChange={(e) =>
                setExpiresAt(combineLocalDateTime(expiryDateTime.date, e.target.value))
              }
              disabled={!expiryDateTime.date}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-main disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => setExpiresAt("")}
            className="w-fit rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-red-500/40 hover:text-red-500"
          >
            {t("clearExpiry")}
          </button>
        </div>
        {/* Management Access */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-surface/40">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-text-main">{t("managementAccess")}</p>
            <p className="text-xs text-text-muted">{t("managementAccessDescription")}</p>
          </div>
          <button
            role="switch"
            aria-checked={manageEnabled}
            onClick={() => setManageEnabled((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              manageEnabled
                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30"
                : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">admin_panel_settings</span>
            {manageEnabled ? tc("enabled") : tc("disabled")}
          </button>
        </div>

        {/* Selected Models Summary (only in restrict mode) */}
        {!allowAll && selectedCount > 0 && (
          <div className="flex flex-col gap-1.5 p-2 bg-primary/5 rounded-lg border border-primary/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-primary">
                {t("selectedCount", { count: selectedCount })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={handleSelectAllModels}
                  className="text-[10px] text-primary hover:bg-primary/10 px-1.5 py-0.5 rounded transition-colors"
                >
                  {tc("all")}
                </button>
                <button
                  onClick={handleDeselectAllModels}
                  className="text-[10px] text-red-500 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition-colors"
                >
                  {t("clear")}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto content-start">
              {selectedModels.map((modelId) => (
                <span
                  key={modelId}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-white dark:bg-surface text-text-main text-[10px] rounded border border-border"
                >
                  <span className="font-mono truncate max-w-[120px]" title={modelId}>
                    {modelId}
                  </span>
                  <button
                    onClick={() => handleToggleModel(modelId)}
                    className="text-text-muted hover:text-red-500 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Search and Model Selection (only in restrict mode) */}
        {!allowAll && (
          <>
            <div className="relative">
              <Input
                value={searchModel}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={t("searchModels")}
                icon="search"
              />
              {searchModel && (
                <button
                  onClick={() => onSearchChange("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              )}
            </div>

            <div className="max-h-[min(42vh,420px)] overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {modelsByProvider.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-text-muted">
                  <span className="material-symbols-outlined text-2xl mb-1">search_off</span>
                  <p className="text-xs">{t("noModelsFound")}</p>
                </div>
              ) : (
                modelsByProvider.map(([provider, models]) => {
                  const selectedInProvider = selectedModels.filter((m) =>
                    models.some((model) => model.id === m)
                  ).length;
                  const allSelected = models.every((m) => selectedModels.includes(m.id));
                  const someSelected = selectedInProvider > 0 && !allSelected;

                  return (
                    <div key={provider} className="group">
                      <button
                        onClick={() => handleToggleExpand(provider)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface/50"
                      >
                        <span
                          className={`material-symbols-outlined text-base transition-transform duration-200 ${
                            expandedProviders.has(provider) ? "rotate-90" : ""
                          }`}
                        >
                          chevron_right
                        </span>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <div
                            className="relative flex items-center cursor-pointer shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleProvider(provider, models);
                            }}
                          >
                            <div
                              className={`w-4 h-4 rounded border-2 transition-colors flex items-center justify-center ${
                                allSelected
                                  ? "bg-primary border-primary"
                                  : someSelected
                                    ? "bg-primary/20 border-primary"
                                    : "border-border hover:border-primary/50"
                              }`}
                            >
                              {allSelected && (
                                <span className="material-symbols-outlined text-white text-[12px]">
                                  check
                                </span>
                              )}
                              {someSelected && !allSelected && (
                                <span className="material-symbols-outlined text-primary text-[12px]">
                                  remove
                                </span>
                              )}
                            </div>
                          </div>
                          <span className="min-w-0 truncate text-xs font-semibold text-text-main">
                            {provider}
                          </span>
                          <span className="text-[10px] text-text-muted bg-surface px-1 py-0.5 rounded shrink-0">
                            {models.length}
                          </span>
                        </div>
                        {selectedInProvider > 0 && (
                          <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full shrink-0">
                            {selectedInProvider}
                          </span>
                        )}
                      </button>

                      {/* Expandable model list */}
                      {expandedProviders.has(provider) && (
                        <div className="px-3 pb-2 sm:pl-9">
                          <div className="grid grid-cols-1 gap-1 sm:flex sm:flex-wrap">
                            {models.map((model) => {
                              const isSelected = selectedModels.includes(model.id);
                              return (
                                <button
                                  key={model.id}
                                  onClick={() => handleToggleModel(model.id)}
                                  className={`min-w-0 truncate rounded-md px-2 py-1 text-left font-mono text-[10px] transition-all sm:inline-flex sm:max-w-[240px] ${
                                    isSelected
                                      ? "bg-primary text-white"
                                      : "bg-surface border border-border text-text-muted hover:border-primary/50 hover:text-text-main"
                                  }`}
                                  title={model.id}
                                >
                                  {model.id}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Allowed Connections Section */}
        {allConnections.length > 0 && (
          <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-surface/40">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-text-main">{t("allowedConnections")}</p>
              <div className="flex gap-1 p-0.5 bg-surface rounded-md">
                <button
                  onClick={() => {
                    setAllowAllConnections(true);
                    setSelectedConnections([]);
                  }}
                  className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                    allowAllConnections
                      ? "bg-primary text-white"
                      : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  {t("allowAllConnections")}
                </button>
                <button
                  onClick={() => setAllowAllConnections(false)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                    !allowAllConnections
                      ? "bg-primary text-white"
                      : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  {t("restrictConnections")}
                </button>
              </div>
            </div>
            <p className="text-xs text-text-muted">
              {allowAllConnections
                ? t("anyActiveConnection")
                : t("restrictedConnections", { count: selectedConnections.length })}
            </p>
            {!allowAllConnections && (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {Object.entries(
                  allConnections.reduce<Record<string, ProviderConnection[]>>((acc, conn) => {
                    const p = conn.provider || t("otherProvider");
                    if (!acc[p]) acc[p] = [];
                    acc[p].push(conn);
                    return acc;
                  }, {})
                )
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([provider, conns]) => (
                    <div key={provider}>
                      <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-1 py-0.5">
                        {provider}
                      </p>
                      {conns.map((conn) => {
                        const isSelected = selectedConnections.includes(conn.id);
                        return (
                          <button
                            key={conn.id}
                            onClick={() => handleToggleConnection(conn.id)}
                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-all ${
                              isSelected
                                ? "bg-primary/10 text-primary"
                                : "text-text-muted hover:bg-surface/50 hover:text-text-main"
                            }`}
                          >
                            <div
                              className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                                isSelected ? "bg-primary border-primary" : "border-border"
                              }`}
                            >
                              {isSelected && (
                                <span className="material-symbols-outlined text-white text-[10px]">
                                  check
                                </span>
                              )}
                            </div>
                            <span className="truncate flex-1">
                              {conn.name || conn.id.slice(0, 8)}
                            </span>
                            {!conn.isActive && (
                              <span className="text-[9px] text-red-400 shrink-0">
                                {t("inactive")}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth>
            {t("savePermissions")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            {tc("cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
});
