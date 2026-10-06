import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  plainApprovalCardOptions,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });

  it("removes answered requests from the composer while retaining their answers in projection data", () => {
    const answered = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
        resolvedAt: v2Now,
        answers: { next: "  continue  " },
      })),
    };
    expect(derivePendingThreadRequests(answered).userInputs).toEqual([]);
    expect(answered.runtimeRequests[0]?.answers).toEqual({ next: "  continue  " });
  });
});

it("carries the MCP elicitation form so the composer can render it", () => {
  const elicitationRequestId = RuntimeRequestId.make("elicitation");
  const elicitation = {
    mode: "form" as const,
    serverName: "supabase",
    message: "Confirm the destructive SQL.",
    fields: [{ key: "confirm", type: "boolean" as const, required: true }],
  };
  const pending = derivePendingThreadRequests({
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        id: elicitationRequestId,
        kind: "mcp-elicitation",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("elicitation-item"),
        threadId: v2Projection.thread.id,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "approval_request",
        requestId: elicitationRequestId,
        requestKind: "mcp-elicitation",
        prompt: elicitation.message,
        appName: "Supabase",
        elicitation,
      },
    ],
  });
  expect(pending.approvals).toEqual([
    {
      requestId: elicitationRequestId,
      requestKind: "mcp-elicitation",
      createdAt: "2026-06-20T00:00:00.000Z",
      detail: elicitation.message,
      appName: "Supabase",
      elicitation,
      responseCapability: "live",
    },
  ]);
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});

describe("plain approval cards", () => {
  const base = {
    requestId: RuntimeRequestId.make("plain"),
    requestKind: "mcp-elicitation" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    responseCapability: "live" as const,
    options: [
      { decision: "cancel" as const, label: "Cancel" },
      { decision: "decline" as const, label: "Decline" },
      { decision: "accept" as const, label: "Submit" },
    ],
  };

  it("never offers accept for a form the card cannot render", () => {
    expect(
      plainApprovalCardOptions({
        ...base,
        elicitation: {
          mode: "form",
          serverName: "supabase",
          message: "Confirm",
          fields: [{ key: "confirm", type: "boolean", required: true }],
        },
      }),
    ).toEqual({
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
      ],
      unavailableHere: true,
    });
  });

  it("never offers completing a URL flow the card does not show", () => {
    expect(
      plainApprovalCardOptions({
        ...base,
        elicitation: {
          mode: "url",
          serverName: "github",
          message: "Sign in",
          url: "https://x.test",
        },
      }),
    ).toEqual({
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
      ],
      unavailableHere: true,
    });
  });

  it("keeps the advertised choices for plain approvals", () => {
    expect(plainApprovalCardOptions(base)).toEqual({
      options: base.options,
      unavailableHere: false,
    });
  });
});
