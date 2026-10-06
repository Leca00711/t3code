import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type McpElicitationPrompt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for request validation"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "mcp-elicitation" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const formPrompt: McpElicitationPrompt = {
  mode: "form",
  serverName: "supabase",
  message: "Confirm the destructive SQL.",
  fields: [
    { key: "confirm", type: "boolean", required: true },
    { key: "reason", type: "string", minLength: 3, required: true },
  ],
};

it.effect("validates MCP elicitation form content before resolving the request", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:mcp-elicitation");
    const sessionId = ProviderSessionId.make("session:mcp-elicitation");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-elicitation-thread"),
      threadId,
      projectId: ProjectId.make("project:mcp-elicitation"),
      title: "Elicitation",
      modelSelection: { instanceId, model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("attach-elicitation-session"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: "claude-sonnet-4-6",
        capabilities: ClaudeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });

    const addRequest = (name: string, elicitation: McpElicitationPrompt) =>
      Effect.gen(function* () {
        const requestId = RuntimeRequestId.make(`request:${name}`);
        const nodeId = NodeId.make(`node:${name}`);
        yield* projections.apply({
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "mcp-elicitation",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: sessionId },
            createdAt: now,
            resolvedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`node:${name}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${name}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${name}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "approval_request",
            requestId,
            requestKind: "mcp-elicitation",
            prompt: elicitation.message,
            appName: elicitation.serverName,
            elicitation,
          },
        });
        return requestId;
      });
    const respond = (
      requestId: RuntimeRequestId,
      name: string,
      input: {
        readonly decision: "accept" | "decline";
        readonly answers?: Record<string, unknown>;
      },
    ) =>
      orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`respond:${name}`),
        threadId,
        requestId,
        ...input,
      });

    const formRequest = yield* addRequest("form", formPrompt);
    // Invalid content is rejected and the request stays pending for another try.
    const invalid = yield* Effect.exit(
      respond(formRequest, "invalid", {
        decision: "accept",
        answers: { confirm: "yes", reason: "x" },
      }),
    );
    assert.isTrue(Exit.isFailure(invalid));
    assert.include(String(invalid), "confirm");
    assert.equal((yield* projections.getRuntimeRequest(threadId, formRequest))?.status, "pending");
    const missing = yield* Effect.exit(respond(formRequest, "missing", { decision: "accept" }));
    assert.isTrue(Exit.isFailure(missing));
    assert.equal((yield* projections.getRuntimeRequest(threadId, formRequest))?.status, "pending");

    yield* respond(formRequest, "valid", {
      decision: "accept",
      answers: { confirm: true, reason: "cleanup" },
    });
    const resolved = yield* projections.getRuntimeRequest(threadId, formRequest);
    assert.equal(resolved?.status, "resolved");
    assert.deepEqual(resolved?.answers, { confirm: true, reason: "cleanup" });

    // Declining never needs content, and stray content is not forwarded.
    const declinedRequest = yield* addRequest("decline", formPrompt);
    yield* respond(declinedRequest, "decline", { decision: "decline", answers: { confirm: 1 } });
    const declined = yield* projections.getRuntimeRequest(threadId, declinedRequest);
    assert.equal(declined?.status, "resolved");
    assert.isUndefined(declined?.answers);

    // URL elicitations accept without content.
    const urlRequest = yield* addRequest("url", {
      mode: "url",
      serverName: "github",
      message: "Authorize the app.",
      url: "https://github.com/login/device",
    });
    yield* respond(urlRequest, "url", { decision: "accept" });
    assert.equal((yield* projections.getRuntimeRequest(threadId, urlRequest))?.status, "resolved");
  }).pipe(Effect.provide(testLayer)),
);
