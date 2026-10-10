import { TelegramClient, type PromoteRights } from "../../telegram/client";
import { toResult } from "../../telegram/errors";
import { deriveCapabilities } from "../../telegram/capabilities";
import { getBotWithSecrets, getProtocolAccount, listTasksForSourceChat } from "../../db/queries";
import { resolveLastN } from "../../jobs/resolveRange";
import { BridgeClient } from "../../protocol/bridgeClient";
import type { ChatLookupResult } from "../../shared/rpcTypes";

/** Loads the bridge + protocol account when the request carries a
 * protocolAccountId query param; null when this is a bot-mode request.
 * Never throws — bridge misconfiguration surfaces as { error }. */
async function loadProtocol(
  env: Env,
  protocolAccountId: string,
): Promise<{ bridge: BridgeClient; phone: string } | { error: string } | null> {
  if (!protocolAccountId) return null;
  const account = await getProtocolAccount(env.DB, protocolAccountId);
  if (!account) return { error: "protocol account not found" };
  try {
    const bridge = await BridgeClient.fromSettings(env.DB);
    return { bridge, phone: account.phone };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function protocolError(message: string): Response {
  return json({ ok: false, errorCode: 0, description: message, reason: "invalid_request" }, 400);
}

function protocolUnsupported(): Response {
  return json(
    { ok: false, errorCode: 0, description: "this action is not supported for protocol accounts", reason: "invalid_request" },
    400,
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** botId looks up an already-saved bot's token in the DB; token is the raw
 * token for a bot the task wizard hasn't saved yet (see handleVerifyBot) —
 * exactly one of the two is expected to be set. */
async function loadClient(env: Env, botId: string, token: string): Promise<TelegramClient | null> {
  if (token) return new TelegramClient(token);
  if (!botId) return null;
  const bot = await getBotWithSecrets(env.DB, botId);
  return bot ? new TelegramClient(bot.token) : null;
}

async function loadClientAndBotId(
  env: Env,
  botId: string,
  token: string,
  botTelegramId: string,
): Promise<{ client: TelegramClient; botTelegramId: number } | null> {
  if (token) {
    const telegramId = Number(botTelegramId);
    if (!telegramId) return null;
    return { client: new TelegramClient(token), botTelegramId: telegramId };
  }
  if (!botId) return null;
  const bot = await getBotWithSecrets(env.DB, botId);
  return bot ? { client: new TelegramClient(bot.token), botTelegramId: bot.bot_id } : null;
}

export async function handleGetChat(env: Env, chatId: string, botId: string, token: string, botTelegramId: string, protocolAccountId = ""): Promise<Response> {
  const proto = await loadProtocol(env, protocolAccountId);
  if (proto) {
    if ("error" in proto) return protocolError(proto.error);
    const result = await toResult(async (): Promise<ChatLookupResult> => {
      const info = await proto.bridge.resolve(proto.phone, chatId);
      const pastTasks = await listTasksForSourceChat(env.DB, [chatId, String(info.id)]);
      return {
        chat: { id: info.id, type: info.type, title: info.title ?? undefined, username: info.username ?? undefined },
        botStatus: "member",
        capabilities: [
          {
            key: "protocol_forward",
            label: "Protocol account can read & forward",
            available: true,
          },
        ],
        pastTasks,
      };
    });
    return json(result, result.ok ? 200 : 400);
  }

  const loaded = await loadClientAndBotId(env, botId, token, botTelegramId);
  if (!loaded) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const { client, botTelegramId: telegramId } = loaded;

  const result = await toResult(async (): Promise<ChatLookupResult> => {
    const chat = await client.getChat(chatId);
    const member = await client.getChatMember(chatId, telegramId);

    let memberCount = undefined;
    try {
      memberCount = await client.getChatMemberCount(chatId);
    } catch (e) {
      // ignore
    }

    let admins = undefined;
    try {
      const adminData = await client.getChatAdministrators(chatId);
      admins = adminData.map((a) => ({
        id: a.user.id,
        name: a.user.first_name + (a.user.username ? ` (@${a.user.username})` : ""),
        status: a.status,
        is_bot: a.user.is_bot,
      }));
    } catch (e) {
      // ignore
    }

    const pastTasks = await listTasksForSourceChat(env.DB, [chatId, String(chat.id)]);

    return {
      chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
      botStatus: member.status,
      capabilities: deriveCapabilities(member, chat.type),
      memberCount,
      admins,
      pastTasks,
    };
  });
  return json(result, result.ok ? 200 : 400);
}

export async function handleInviteLink(env: Env, chatId: string, botId: string, token: string, protocolAccountId = ""): Promise<Response> {
  if (protocolAccountId) return protocolUnsupported();
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.createChatInviteLink(chatId));
  return json(result, result.ok ? 200 : 400);
}

export async function handleRevokeInviteLink(env: Env, chatId: string, botId: string, inviteLink: string, token: string, protocolAccountId = ""): Promise<Response> {
  if (protocolAccountId) return protocolUnsupported();
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.revokeChatInviteLink(chatId, inviteLink));
  return json(result, result.ok ? 200 : 400);
}

export async function handleBan(env: Env, chatId: string, botId: string, userId: number, token: string, protocolAccountId = ""): Promise<Response> {
  if (protocolAccountId) return protocolUnsupported();
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.banChatMember(chatId, userId));
  return json(result, result.ok ? 200 : 400);
}

export async function handleUnban(env: Env, chatId: string, botId: string, userId: number, token: string, protocolAccountId = ""): Promise<Response> {
  if (protocolAccountId) return protocolUnsupported();
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.unbanChatMember(chatId, userId));
  return json(result, result.ok ? 200 : 400);
}

export async function handlePromote(
  env: Env,
  chatId: string,
  botId: string,
  userId: number,
  rights: PromoteRights,
  token: string,
  protocolAccountId = "",
): Promise<Response> {
  if (protocolAccountId) return protocolUnsupported();
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.promoteChatMember(chatId, userId, rights));
  return json(result, result.ok ? 200 : 400);
}

export async function handleSendTestMessage(env: Env, chatId: string, botId: string, text: string, token: string, protocolAccountId = ""): Promise<Response> {
  const proto = await loadProtocol(env, protocolAccountId);
  if (proto) {
    if ("error" in proto) return protocolError(proto.error);
    const result = await toResult(() => proto.bridge.sendTest(proto.phone, chatId, text));
    return json(result, result.ok ? 200 : 400);
  }
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.sendMessage(chatId, text));
  return json(result, result.ok ? 200 : 400);
}

/** Probe-and-delete trick: send a throwaway message to learn the chat's
 * current highest message id, then best-effort delete it. Deletion
 * failure is non-fatal — it's logged but doesn't fail the lookup. */
export async function handleLatestMessageId(env: Env, chatId: string, botId: string, token: string, protocolAccountId = ""): Promise<Response> {
  const proto = await loadProtocol(env, protocolAccountId);
  if (proto) {
    if ("error" in proto) return protocolError(proto.error);
    const result = await toResult(async () => {
      const latestMessageId = await proto.bridge.latestId(proto.phone, chatId);
      return { latestMessageId, cleanupOk: true };
    });
    return json(result, result.ok ? 200 : 400);
  }
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const result = await toResult(async () => {
    const { endId, cleanupOk } = await resolveLastN(client, chatId, 1);
    return { latestMessageId: endId, cleanupOk };
  });
  return json(result, result.ok ? 200 : 400);
}

/** Wizard dry-run: not tied to a saved task yet — resolves the source
 * chat's latest message and copies it to the given destination once, so
 * the user can validate the pipeline before committing. */
export async function handleAdHocTestCopy(
  env: Env,
  sourceChatId: string,
  botId: string,
  destChatId: string,
  token: string,
  messageId?: number,
  protocolAccountId = "",
): Promise<Response> {
  const proto = await loadProtocol(env, protocolAccountId);
  if (proto) {
    if ("error" in proto) return protocolError(proto.error);
    const result = await toResult(async () => {
      let copyId = messageId;
      if (!copyId) copyId = await proto.bridge.latestId(proto.phone, sourceChatId);
      const res = await proto.bridge.forwardBatch(proto.phone, sourceChatId, destChatId, [copyId]);
      if (res.copied.length === 0) throw new Error(res.failed[0]?.error ?? "forward failed");
      return { message_id: res.copied[0] };
    });
    return json(result, result.ok ? 200 : 400);
  }
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, sourceChatId, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(destChatId, sourceChatId, copyId);
  });
  return json(result, result.ok ? 200 : 400);
}
