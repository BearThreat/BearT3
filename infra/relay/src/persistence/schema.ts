import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const relayMobileDevices = pgTable(
  "relay_mobile_devices",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: varchar("platform", { length: 16 }).notNull().$type<"ios">(),
    iosMajorVersion: integer("ios_major_version").notNull(),
    appVersion: varchar("app_version", { length: 64 }),
    bundleId: varchar("bundle_id", { length: 255 }),
    apsEnvironment: varchar("aps_environment", { length: 16 }).$type<"sandbox" | "production">(),
    pushToken: text("push_token"),
    pushToStartToken: text("push_to_start_token"),
    preferencesJson: jsonb("preferences_json").notNull().$type<RelayAgentAwarenessPreferences>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_mobile_devices_push_token").on(table.pushToken),
    uniqueIndex("idx_relay_mobile_devices_push_to_start_token").on(table.pushToStartToken),
  ],
);

export const relayLiveActivities = pgTable(
  "relay_live_activities",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    activityPushToken: text("activity_push_token"),
    remoteStartQueuedAt: varchar("remote_start_queued_at", { length: 64 }),
    remoteStartedAt: varchar("remote_started_at", { length: 64 }),
    endedAt: varchar("ended_at", { length: 64 }),
    lastAggregateJson: jsonb("last_aggregate_json").$type<RelayAgentActivityAggregateState>(),
    lastLiveActivityDeliveryAt: varchar("last_live_activity_delivery_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_live_activities_activity_push_token").on(table.activityPushToken),
  ],
);

export const relayEnvironmentLinks = pgTable(
  "relay_environment_links",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentLabel: text("environment_label").notNull().default("T3 Environment"),
    environmentPublicKey: text("environment_public_key").notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url").notNull(),
    endpointWsBaseUrl: text("endpoint_ws_base_url").notNull(),
    endpointProviderKind: varchar("endpoint_provider_kind", { length: 32 }).notNull(),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    liveActivitiesEnabled: boolean("live_activities_enabled").notNull().default(true),
    managedTunnelsEnabled: boolean("managed_tunnels_enabled").notNull().default(false),
    createdByDeviceId: varchar("created_by_device_id", { length: 191 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    index("idx_relay_environment_links_environment").on(table.environmentId, table.revokedAt),
  ],
);

export const relayManagedEndpointAllocations = pgTable(
  "relay_managed_endpoint_allocations",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    hostname: text("hostname").notNull(),
    tunnelId: varchar("tunnel_id", { length: 191 }),
    tunnelName: text("tunnel_name").notNull(),
    dnsRecordId: varchar("dns_record_id", { length: 191 }),
    readyAt: varchar("ready_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    uniqueIndex("idx_relay_managed_endpoint_allocations_hostname").on(table.hostname),
    uniqueIndex("idx_relay_managed_endpoint_allocations_tunnel_name").on(table.tunnelName),
  ],
);

export const relayManagedTunnelLimits = pgTable("relay_managed_tunnel_limits", {
  userId: varchar("user_id", { length: 191 }).primaryKey(),
  maxTunnels: integer("max_tunnels").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayEnvironmentCredentials = pgTable(
  "relay_environment_credentials",
  {
    credentialId: varchar("credential_id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    credentialHash: varchar("credential_hash", { length: 191 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_environment_credentials_hash").on(table.credentialHash),
    index("idx_relay_environment_credentials_environment").on(table.environmentId, table.revokedAt),
    index("idx_relay_environment_credentials_environment_key").on(
      table.environmentId,
      table.environmentPublicKey,
      table.revokedAt,
    ),
  ],
);

export const relayAgentActivityRows = pgTable(
  "relay_agent_activity_rows",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    threadId: varchar("thread_id", { length: 191 }).notNull(),
    stateJson: jsonb("state_json").notNull().$type<RelayAgentActivityState>(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.environmentPublicKey, table.threadId] }),
    index("idx_relay_agent_activity_rows_updated").on(table.updatedAt),
  ],
);

export const relayDeliveryAttempts = pgTable(
  "relay_delivery_attempts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    environmentId: varchar("environment_id", { length: 191 }),
    threadId: varchar("thread_id", { length: 191 }),
    deviceId: varchar("device_id", { length: 255 }),
    kind: varchar("kind", { length: 64 }).notNull(),
    sourceJobId: varchar("source_job_id", { length: 64 }),
    tokenSuffix: varchar("token_suffix", { length: 16 }),
    apnsStatus: integer("apns_status"),
    apnsReason: text("apns_reason"),
    apnsId: varchar("apns_id", { length: 128 }),
    transportError: text("transport_error"),
  },
  (table) => [
    index("idx_relay_delivery_attempts_environment").on(
      table.environmentId,
      table.threadId,
      table.createdAt,
    ),
    uniqueIndex("idx_relay_delivery_attempts_source_job").on(table.sourceJobId),
  ],
);

export const relayDpopProofs = pgTable(
  "relay_dpop_proofs",
  {
    thumbprint: varchar("thumbprint", { length: 128 }).notNull(),
    jti: varchar("jti", { length: 255 }).notNull(),
    iat: integer("iat").notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.thumbprint, table.jti] }),
    index("idx_relay_dpop_proofs_expires_at").on(table.expiresAt),
  ],
);

export const relaySupportIssues = pgTable(
  "relay_support_issues",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    receiptId: varchar("receipt_id", { length: 64 }).notNull(),
    subject: varchar("subject", { length: 160 }).notNull(),
    description: text("description").notNull(),
    diagnosticsConsent: boolean("diagnostics_consent").notNull().default(false),
    diagnosticsJson: jsonb("diagnostics_json").$type<{
      readonly appVersion?: string | undefined;
      readonly platform?: string | undefined;
      readonly route?: string | undefined;
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly errorCode?: string | undefined;
      readonly traceId?: string | undefined;
    }>(),
    status: varchar("status", { length: 32 })
      .notNull()
      .$type<"received" | "reviewing" | "resolved" | "closed">()
      .default("received"),
    operatorReply: text("operator_reply"),
    repliedAt: varchar("replied_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.receiptId] }),
    index("idx_relay_support_issues_user_updated").on(table.userId, table.updatedAt),
    index("idx_relay_support_issues_status_updated").on(table.status, table.updatedAt),
  ],
);

export const salvoHostedSandboxes = pgTable(
  "salvo_hosted_sandboxes",
  {
    sandboxId: varchar("sandbox_id", { length: 64 }).primaryKey(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    status: varchar("status", { length: 16 })
      .notNull()
      .$type<"starting" | "ready" | "draining" | "stopped" | "failed">(),
    providerRef: text("provider_ref"),
    endpoint: text("endpoint"),
    failureReason: varchar("failure_reason", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_salvo_hosted_sandboxes_user").on(table.userId),
    uniqueIndex("idx_salvo_hosted_sandboxes_user_request").on(table.userId, table.requestId),
  ],
);

export const salvoSandboxBootstrapTokens = pgTable(
  "salvo_sandbox_bootstrap_tokens",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    sandboxId: varchar("sandbox_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    clientToken: varchar("client_token", { length: 64 }).notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretHash: varchar("secret_hash", { length: 64 }),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    controlExpiresAt: varchar("control_expires_at", { length: 64 }).notNull(),
    consumedAt: varchar("consumed_at", { length: 64 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    tunnelId: varchar("tunnel_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull().default(1),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    index("idx_salvo_bootstrap_tokens_binding").on(
      table.sandboxId,
      table.userId,
      table.clientToken,
    ),
  ],
);

export const salvoHostedSandboxPrompts = pgTable(
  "salvo_hosted_sandbox_prompts",
  {
    sandboxId: varchar("sandbox_id", { length: 64 }).notNull(),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    prompt: text("prompt").notNull(),
    status: varchar("status", { length: 16 })
      .notNull()
      .$type<"pending" | "dispatching" | "accepted">(),
    leaseToken: varchar("lease_token", { length: 64 }),
    leaseExpiresAt: varchar("lease_expires_at", { length: 64 }),
    sandboxExecutionReceiptId: varchar("sandbox_execution_receipt_id", { length: 191 }),
    gatewayProviderReceiptId: varchar("gateway_provider_receipt_id", { length: 191 }),
    acceptedAt: varchar("accepted_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sandboxId, table.requestId] }),
    index("idx_salvo_hosted_sandbox_prompts_user").on(table.userId, table.createdAt),
    index("idx_salvo_hosted_sandbox_prompts_lease").on(table.status, table.leaseExpiresAt),
  ],
);

export const salvoProvisioningStops = pgTable("salvo_provisioning_stops", {
  scope: varchar("scope", { length: 191 }).primaryKey(),
  stopped: boolean("stopped").notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const salvoProvisioningStopAudits = pgTable("salvo_provisioning_stop_audits", {
  requestId: varchar("request_id", { length: 128 }).primaryKey(),
  operatorUserId: varchar("operator_user_id", { length: 191 }).notNull(),
  scope: varchar("scope", { length: 191 }).notNull(),
  stopped: boolean("stopped").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
});

export const salvoSandboxLifecycleHistory = pgTable(
  "salvo_sandbox_lifecycle_history",
  {
    eventId: varchar("event_id", { length: 64 }).primaryKey(),
    sandboxId: varchar("sandbox_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    event: varchar("event", { length: 32 }).notNull(),
    detail: text("detail"),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_salvo_lifecycle_history_sandbox").on(table.sandboxId, table.createdAt)],
);

export const salvoGauntletProbeReservations = pgTable(
  "salvo_gauntlet_probe_reservations",
  {
    reservationId: varchar("reservation_id", { length: 64 }).primaryKey(),
    deploymentRevision: varchar("deployment_revision", { length: 128 }).notNull(),
    nonce: varchar("nonce", { length: 36 }).notNull(),
    fixtureSetHash: varchar("fixture_set_hash", { length: 64 }).notNull(),
    scenarioId: varchar("scenario_id", { length: 96 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_salvo_gauntlet_probe_revision_nonce").on(
      table.deploymentRevision,
      table.nonce,
    ),
    uniqueIndex("idx_salvo_gauntlet_probe_revision_fixtures").on(
      table.deploymentRevision,
      table.fixtureSetHash,
    ),
  ],
);

export const salvoCanaryBudgetControl = pgTable("salvo_canary_budget_control", {
  singleton: integer("singleton").primaryKey(),
  stopped: boolean("stopped").notNull().default(false),
  capMicros: bigint("cap_micros", { mode: "number" }).notNull(),
  authoritativeBilledMicros: bigint("authoritative_billed_micros", { mode: "number" })
    .notNull()
    .default(0),
  authoritativeObservedAt: varchar("authoritative_observed_at", { length: 64 }),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const salvoCanaryBudgetReservations = pgTable(
  "salvo_canary_budget_reservations",
  {
    reservationId: varchar("reservation_id", { length: 191 }).primaryKey(),
    kind: varchar("kind", { length: 16 }).notNull().$type<"aws" | "openai">(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
    status: varchar("status", { length: 16 }).notNull().$type<"active" | "settled" | "released">(),
    actualMicros: bigint("actual_micros", { mode: "number" }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_salvo_canary_budget_status").on(table.status, table.updatedAt)],
);

export const salvoSponsoredInferenceControl = pgTable("salvo_sponsored_inference_control", {
  singleton: integer("singleton").primaryKey(),
  stopped: boolean("stopped").notNull().default(false),
  reservedMicros: integer("reserved_micros").notNull().default(0),
  billedMicros: integer("billed_micros").notNull().default(0),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const salvoSponsoredInferenceUsers = pgTable("salvo_sponsored_inference_users", {
  userId: varchar("user_id", { length: 191 }).primaryKey(),
  reservedMicros: integer("reserved_micros").notNull().default(0),
  billedMicros: integer("billed_micros").notNull().default(0),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const salvoSponsoredInferenceGrants = pgTable(
  "salvo_sponsored_inference_grants",
  {
    grantId: varchar("grant_id", { length: 64 }).primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    sandboxId: varchar("sandbox_id", { length: 191 }).notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_salvo_sponsored_inference_grants_token_hash").on(table.tokenHash),
    index("idx_salvo_sponsored_inference_grants_owner").on(table.userId, table.sandboxId),
  ],
);

export const salvoSponsoredInferenceRequests = pgTable(
  "salvo_sponsored_inference_requests",
  {
    requestId: varchar("request_id", { length: 191 }).primaryKey(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    sandboxId: varchar("sandbox_id", { length: 191 }).notNull(),
    turnId: varchar("turn_id", { length: 191 }).notNull(),
    model: varchar("model", { length: 191 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().$type<"running" | "completed" | "failed">(),
    reservedMicros: integer("reserved_micros").notNull(),
    billedMicros: integer("billed_micros"),
    responseText: text("response_text"),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    index("idx_salvo_sponsored_inference_requests_user").on(table.userId, table.createdAt),
  ],
);

export const salvoSponsoredInferenceAudits = pgTable(
  "salvo_sponsored_inference_audits",
  {
    auditId: varchar("audit_id", { length: 64 }).primaryKey(),
    requestId: varchar("request_id", { length: 191 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    eventType: varchar("event_type", { length: 16 })
      .notNull()
      .$type<"accepted" | "completed" | "rejected" | "failed">(),
    reason: varchar("reason", { length: 64 }),
    /** Deliberately allowlisted metadata; prompts and provider response text never belong here. */
    detailsJson: jsonb("details_json")
      .notNull()
      .$type<{
        readonly sandboxId: string;
        readonly turnId: string;
        readonly model: string;
        readonly maxOutputTokens: number;
        readonly reserveMicros: number;
      }>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    index("idx_salvo_sponsored_inference_audits_request").on(table.requestId, table.createdAt),
  ],
);

export const salvoSponsoredResponseCalls = pgTable("salvo_sponsored_response_calls", {
  callId: varchar("call_id", { length: 64 }).primaryKey(),
  parentRequestId: varchar("parent_request_id", { length: 191 }).notNull(),
  userId: varchar("user_id", { length: 191 }).notNull(),
  sandboxId: varchar("sandbox_id", { length: 191 }).notNull(),
  fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().$type<"running" | "completed" | "failed">(),
  reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
  billedMicros: bigint("billed_micros", { mode: "number" }),
  responseBase64: text("response_base64"),
  responseContentType: varchar("response_content_type", { length: 191 }),
  leaseExpiresAt: varchar("lease_expires_at", { length: 64 }),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});
