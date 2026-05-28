/**
 * ollama-proxy — Hybrid think-control proxy for Claude Code + Ollama
 * ==================================================================
 * think=true  → /v1/messages + thinking:enabled
 * think=false → /api/chat   + think:false
 *
 * ENV:
 * OLLAMA_PROXY_OLLAMA_HOST, OLLAMA_PROXY_OLLAMA_PORT
 * OLLAMA_PROXY_OLLAMA_MODEL, OLLAMA_PROXY_OLLAMA_MODEL_THINK
 * OLLAMA_PROXY_NUM_CTX, OLLAMA_PROXY_NUM_CTX_THINK, OLLAMA_PROXY_CONTEXT_WINDOW
 * 
 * 在 Claude Code 中將 ANTHROPIC_BASE_URL 指向 http://<proxy-host>:11435 即可
 *
 * 支援 Claude Code 自訂標頭：
 *   anthropic-beta, x-claude-code-session-id, x-claude-code-agent-id 等
 *   (僅記錄於日誌，不轉發給 Ollama，避免不相容)
 */
const express = require("express");
const http    = require("http");

const OLLAMA_HOST       = process.env.OLLAMA_PROXY_OLLAMA_HOST  || "localhost";
const OLLAMA_PORT       = parseInt(process.env.OLLAMA_PROXY_OLLAMA_PORT   || "11434");
const PROXY_PORT        = parseInt(process.env.OLLAMA_PROXY_PORT          || "11435");
const FORCE_MODEL       = process.env.OLLAMA_PROXY_OLLAMA_MODEL || "";
const FORCE_MODEL_THINK = process.env.OLLAMA_PROXY_OLLAMA_MODEL_THINK  || "";
const NUM_CTX           = parseInt(process.env.OLLAMA_PROXY_NUM_CTX       || "32768");
const NUM_CTX_THINK     = parseInt(process.env.OLLAMA_PROXY_NUM_CTX_THINK || NUM_CTX);
const KEEPALIVE_MS      = 15_000;

const CONTEXT_WINDOW    = parseInt(process.env.OLLAMA_PROXY_CONTEXT_WINDOW || String(NUM_CTX));

// 動態 token 校正因子（僅用於 /api/chat 路徑）
let tokenCorrectionFactor = 1.0;

const app = express();
app.use(express.json({ limit: "50mb" }));

// ── 輔助函數 ────────────────────────────────────────────────────────────────
function cleanModelName(model) {
  if (!model) return "";
  return model.replace(/\[1m\]$/i, "").trim();
}

function resolveModel(baseModel, useThink) {
  const clean = cleanModelName(baseModel);
  if (useThink && FORCE_MODEL_THINK) return FORCE_MODEL_THINK;
  if (FORCE_MODEL) return FORCE_MODEL;
  return clean;
}

function getNumCtx(useThink) {
  return useThink ? NUM_CTX_THINK : NUM_CTX;
}

// ── Think 決策 ──────────────────────────────────────────────────────────────
function resolveThink(body, betaHeaders = "") {
  const t = body.thinking;
  if (!t) return false;

  // 支援 Anthropic API 的 thinking type: enabled
  if (t.type === "enabled") return (t.budget_tokens ?? 0) > 0;

  if (t.type === "adaptive") {
    // 若請求頭包含 adaptive-thinking-2026-01-28，且為 adaptive 模式，可根據關鍵字或一律啟用
    // 此處保留原關鍵字邏輯，並可從 beta 頭判斷輔助
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === "user");
    const text = typeof lastUser?.content === "string"
      ? lastUser.content
      : (lastUser?.content ?? []).filter(b => b.type === "text").map(b => b.text).join(" ");
    const lower = text.toLowerCase();

    const EN_THINK = ["ultrathink","think harder","think very hard","think really hard","think super hard","think intensely","think longer","megathink","think hard","think about it","think a lot","think deeply","think more","think carefully","think step by step"];
    const ZH_TW_THINK = ["深思","深入思考","深度思考","仔細思考","認真思考","好好想想","仔細分析","深入分析","全面分析","徹底分析","深入研究","仔細研究","用心思考","審慎思考","好好思考","思考看看","好好分析","分析一下","想清楚","想仔細","仔細想","思考","想想","分析"];
    const ZH_CN_THINK = ["深思","深入思考","深度思考","仔细思考","认真思考","好好想想","仔细分析","深入分析","全面分析","彻底分析","深入研究","仔细研究","用心思考","慎重思考","多想一会","多想一想","好好思考","好好分析","分析一下","想清楚","想仔细","仔细想","思考","想想","分析"];
    const JA_THINK = ["じっくり考えて","深く考えて","よく考えて","慎重に考えて"];

    const ALL_KEYWORDS = [...EN_THINK, ...ZH_TW_THINK, ...ZH_CN_THINK, ...JA_THINK];
    const matched = ALL_KEYWORDS.find(kw => lower.includes(kw));
    //if (matched) console.log(`[KEYWORD] matched="${matched}"`);
    return !!matched;
  }
  return false;
}

// ── 改良版 Token 估算 ──────────────────────────────────────────────────────
function estimateTokens(val) {
  if (!val) return 0;
  if (typeof val === "string") {
    const ascii = (val.match(/[\x00-\x7F]/g) || []).length;
    const nonAscii = val.length - ascii;
    return Math.ceil(ascii / 4) + Math.ceil(nonAscii / 1.5);
  }
  if (Array.isArray(val)) {
    return val.reduce((sum, item) => sum + estimateTokens(item), 0);
  }
  if (typeof val === "object") {
    try {
      return estimateTokens(JSON.stringify(val));
    } catch {
      return 0;
    }
  }
  return 0;
}

// ── think=true (直接轉發 /v1/messages) ──────────────────────────────────────
function passthroughThink(body, res) {
  const model = resolveModel(body.model, true);
  const numCtx = getNumCtx(true);
  const fixed = {
    ...body,
    model,
    thinking: { type: "enabled", budget_tokens: body.thinking?.budget_tokens ?? 16000 },
    options: { ...(body.options || {}), num_ctx: numCtx }
  };
  proxyToOllama("/v1/messages", fixed, res, body.stream ?? false);
}

// ── 工具相關函數 ───────────────────────────────────────────────────────────
function toOllamaMessages(messages, system) {
  const result = [];
  if (system) {
    const sys = Array.isArray(system) ? system.map(b => b.text ?? "").join(" ") : system;
    if (sys.trim()) result.push({ role: "system", content: sys });
  }
  for (const m of messages) {
    const role = m.role ?? "user";
    const content = m.content;
    if (typeof content === "string") {
      if (content.trim()) result.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const text = content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
      const tools = content.filter(b => b.type === "tool_use");
      const msg = { role: "assistant", content: text };
      if (tools.length > 0) {
        msg.tool_calls = tools.map(b => ({
          id: b.id ?? "",
          function: { name: b.name, arguments: b.input ?? {} }
        }));
      }
      result.push(msg);
      continue;
    }

    const text = content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    const results = content.filter(b => b.type === "tool_result");
    const images = content
      .filter(b => b.type === "image" && b.source?.type === "base64")
      .map(b => b.source.data ?? "")
      .filter(Boolean);

    if (text || images.length > 0) {
      const msg = { role: "user", content: text };
      if (images.length > 0) msg.images = images;
      result.push(msg);
    }

    for (const tr of results) {
      const inner = Array.isArray(tr.content)
        ? tr.content.map(x => typeof x === "object" ? (x.text ?? "") : x).join("\n")
        : (tr.content ?? "");
      const toolMsg = { role: "tool", content: inner };
      const match = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
        .find(b => b.type === "tool_use" && b.id === tr.tool_use_id);
      if (match?.name) toolMsg.tool_name = match.name;
      result.push(toolMsg);
    }
    if (!text && results.length === 0) result.push({ role: "user", content: "" });
  }
  return result;
}

const ANTHROPIC_SERVER_TOOLS = new Set([
  "web_search", "web_fetch", "code_execution", "WebSearch", "WebFetch"
]);

function isServerTool(t) {
  if (t.type && /^(web_search|web_fetch|code_execution)_/.test(t.type)) return true;
  return ANTHROPIC_SERVER_TOOLS.has(t.name);
}

function toOllamaTools(tools = []) {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} }
    }
  }));
}

// fixToolCall 完整保留（略，與原始碼相同）
const KNOWN_TOOLS = new Set(["Agent","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","ListMcpResourcesTool","LSP","NotebookEdit","Read","ReadMcpResourceTool","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WaitForMcpServers","WebFetch","WebSearch","Write"]);
const SHELL_RE = /^(find|ls|cat|grep|echo|cd|mkdir|rm|mv|cp|touch|chmod|curl|wget|git|npm|node|python|pip|sed|awk|sort|head|tail|wc|ps|which|stat)\b/;

function fixToolCall(rawName, rawInput) {
  const clean = rawName.replace(/<\/?\w[^>]*>/g, "").trim();
  let name = clean, input = rawInput;
  if (!KNOWN_TOOLS.has(clean) && !clean.startsWith("mcp__") && (SHELL_RE.test(clean) || clean.includes(" "))) {
    name  = "Bash";
    input = { command: clean.replace(/<\/parameter[\s\S]*$/, "").trim() };
    //console.log(`[REPAIR] name→Bash: "${name.slice(0,60)}"`);
  }
  if (typeof input !== "object" || input === null) return { name, input };
  switch (name) {
    case "Bash": {
      const cmd = input.command ?? input.code ?? input.cmd ?? input.script ?? input.shell;
      //if (cmd && !input.command) console.log(`[FIX] Bash: remapped to "command"`);
      const out = { command: cmd ?? "" };
      if (input.timeout !== undefined) out.timeout = input.timeout;
      return { name, input: out };
    }
    case "Read": {
      const fp = input.file_path ?? input.path ?? input.file ?? input.filepath ?? input.filename;
      //if (fp && !input.file_path) console.log(`[FIX] Read: remapped to "file_path"`);
      const out = { file_path: fp ?? "" };
      if (input.offset !== undefined) out.offset = input.offset;
      if (input.limit  !== undefined) out.limit  = input.limit;
      return { name, input: out };
    }
    case "Write": {
      const fp = input.file_path ?? input.path ?? input.file ?? input.filepath;
      const content = input.content ?? input.text ?? input.data ?? input.body;
      //if (fp && !input.file_path) console.log(`[FIX] Write: remapped to "file_path"`);
      return { name, input: { file_path: fp ?? "", content: content ?? "" } };
    }
    case "Edit": {
      const fp = input.file_path ?? input.path ?? input.file ?? input.filepath;
      const out = { ...input };
      if (fp && !out.file_path) { out.file_path = fp; delete out.path; }
      if (!out.old_string && out.old_str) { out.old_string = out.old_str; delete out.old_str; }
      if (!out.new_string && out.new_str) { out.new_string = out.new_str; delete out.new_str; }
      return { name, input: out };
    }
    case "Glob": {
      const pattern = input.pattern ?? input.glob ?? input.file_pattern ?? "";
      if (!pattern) return { name, input };
      const out = { pattern };
      if (input.path !== undefined) out.path = input.path;
      return { name, input: out };
    }
    case "Grep": {
      const pattern = input.pattern ?? input.query ?? input.search ?? input.regex ?? "";
      if (!pattern) return { name, input };
      const GREP_KEYS = new Set(["pattern","path","output_mode","glob","type","-i","-n","-A","-B","-C","multiline","head_limit"]);
      const out = { pattern };
      for (const [k,v] of Object.entries(input)) {
        if (k !== "pattern" && GREP_KEYS.has(k)) out[k] = v;
      }
      return { name, input: out };
    }
    case "WebFetch": {
      const url = input.url ?? input.link ?? input.href ?? "";
      //if (url && !input.url) console.log(`[FIX] WebFetch: remapped to "url"`);
      return { name, input: { url } };
    }
    case "WebSearch": {
      const query = input.query ?? input.search ?? input.q ?? "";
      //if (query && !input.query) console.log(`[FIX] WebSearch: remapped to "query"`);
      return { name, input: { query } };
    }
    case "NotebookEdit": {
      const np = input.notebook_path ?? input.path ?? input.file_path ?? "";
      const out = { ...input };
      if (np && !out.notebook_path) { out.notebook_path = np; delete out.path; delete out.file_path; }
      return { name, input: out };
    }
    default:
      return { name, input };
  }
}

// ── Streaming 轉換 (即時 NDJSON → Anthropic SSE) ───────────────────────────
function streamToAnthropic(ollamaStream, res, model) {
  const msgId = `msg_${Math.random().toString(36).slice(2, 18)}`;
  let localInputTokens = 0;
  let localOutputTokens = 0;
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sse = (e, d) => {
    if (!res.writableEnded) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  };

  sse("message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  const ka = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, KEEPALIVE_MS);

  const done = () => {
    clearInterval(ka);
    if (!res.writableEnded) res.end();
  };

  let buf = "";
  let textBlockStarted = false;
  // ★ tool call 改為 buffer，key 用 Ollama 傳來的 index（或順序）
  // 結構：Map<number, { name: string, arguments: object }>
  const toolCallMap = new Map();

  ollamaStream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        const message = p.message || {};
        
        if (p.done) {
          if (p.done) {
            localInputTokens = p.prompt_eval_count ?? 0;
            localOutputTokens = p.eval_count ?? 0;
          }
        }

        // ── 文字：照常即時串流 ──────────────────────────────
        const deltaText = message.content || "";
        if (deltaText) {
          if (!textBlockStarted) {
            sse("content_block_start", {
              type: "content_block_start", index: 0,
              content_block: { type: "text", text: "" }
            });
            textBlockStarted = true;
          }
          sse("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: deltaText }
          });
        }

        // ── Tool call：只累積，不送出 ──────────────────────
        const toolCalls = message.tool_calls || [];
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          // 用 index i 作為 key，Ollama 每次 chunk 可能送相同 index 的更新版本
          // 直接覆蓋（Ollama streaming 工具呼叫是累積更新，非差分）
          toolCallMap.set(i, {
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || {}
          });
        }
      } catch {
        // 忽略單行解析失敗
      }
    }
  });

  ollamaStream.on("end", () => {
    //console.log(`[STREAM] ended, textBlock=${textBlockStarted}, toolCalls=${toolCallMap.size}`);

    // 關閉文字 block
    if (textBlockStarted) {
      sse("content_block_stop", { type: "content_block_stop", index: 0 });
    }

    // 送出所有完整的 tool call（stream 結束後才送，保證完整性）
    let toolIndex = textBlockStarted ? 1 : 0;
    for (const [, tc] of toolCallMap) {
      const fixed = fixToolCall(tc.name, tc.arguments);
      const toolCallId = `toolu_${Math.random().toString(36).slice(2, 14)}`;

      sse("content_block_start", {
        type: "content_block_start",
        index: toolIndex,
        content_block: { type: "tool_use", id: toolCallId, name: fixed.name, input: {} }
      });
      sse("content_block_delta", {
        type: "content_block_delta",
        index: toolIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(fixed.input) }
      });
      sse("content_block_stop", {
        type: "content_block_stop", index: toolIndex
      });

      toolIndex++;
    }

    const stopReason = toolCallMap.size > 0 ? "tool_use" : "end_turn";
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: localInputTokens, output_tokens: localOutputTokens }
    });
    sse("message_stop", { type: "message_stop" });
    done();
  });

  ollamaStream.on("error", (e) => {
    console.error("[STREAM] error", e);
    done();
  });
}

// ── 修正與完全體版本的 noThinkApiChat ──────────────────────────────────────────
function noThinkApiChat(body, res) {
  const model = resolveModel(body.model, false);
  const isStream = body.stream ?? false;
  const tools = (body.tools ?? []).filter(t => !isServerTool(t));
  let system = body.system ?? "";
  if (Array.isArray(system)) system = system.map(b => b.text ?? "").join(" ");

  const ollamaBody = {
    model,
    messages: toOllamaMessages(body.messages ?? [], system),
    think: false, // 關閉思考鏈
    stream: isStream,
    options: { num_predict: body.max_tokens ?? 8192, num_ctx: getNumCtx(false) },
    ...(tools.length > 0 ? { tools: toOllamaTools(tools) } : {})
  };

  const payload = JSON.stringify(ollamaBody);
  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: "/api/chat",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };

  //console.log(`[DEBUG] /api/chat request sent, stream=${isStream}`);

  const req = http.request(options, (ollamaRes) => {
    if (isStream) {
      // 串流模式：直接將 Ollama 的 response 丟進轉譯器處理
      streamToAnthropic(ollamaRes, res, model);
    } else {
      // 非串流模式：收集完整資料後，一次性打包成 Anthropic 格式 JSON 回傳
      let buf = "";
      ollamaRes.on("data", (c) => { buf += c.toString(); });
      ollamaRes.on("end", () => {
        try {
          const lines = buf.split("\n").filter(l => l.trim());
          let fullText = "";
          let inputTokens = 0;
          let outputTokens = 0;

          for (const line of lines) {
            const p = JSON.parse(line);
            fullText += p.message?.content || "";
            if (p.done) {
              inputTokens = p.prompt_eval_count ?? 0;
              outputTokens = p.eval_count ?? 0;
            }
          }
          
          const anthropicResponse = {
            id: `msg_${Math.random().toString(36).slice(2, 18)}`,
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: fullText }],
            stop_reason: "end_turn",
            usage: { input_tokens: inputTokens, output_tokens: outputTokens }
          };

          res.json(anthropicResponse);
        } catch (err) {
          console.error("[JSON PARSE ERROR]", err);
          if (!res.headersSent) res.status(500).json({ error: "Failed to parse Ollama response" });
        }
      });
    }
  });

  req.on("error", (err) => {
    console.error("[ERROR]", err);
    if (!res.headersSent) {
      res.status(502).json({ error: { type: "proxy_error", message: err.message } });
    }
  });

  req.setTimeout(300_000, () => req.destroy());
  req.write(payload);
  req.end();
}

// ── 直接轉發 /v1/messages (think=true 或無強制模型時) ──────────────────────
function proxyToOllama(path, body, res, isStream) {
  const payload = JSON.stringify(body);
  const options = {
    hostname: OLLAMA_HOST, port: OLLAMA_PORT, path, method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      // 不轉發 anthropic-beta / x-claude-code-*，避免 Ollama 報錯
    }
  };
  const req = http.request(options, (r) => {
    res.status(r.statusCode);
    for (const [k,v] of Object.entries(r.headers)) {
      if (!["transfer-encoding","connection"].includes(k.toLowerCase())) res.setHeader(k,v);
    }
    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      const ka = setInterval(() => { if(!res.writableEnded) res.write(": keep-alive\n\n"); }, KEEPALIVE_MS);
      r.on("data", c => { if(!res.writableEnded) res.write(c); });
      r.on("end", () => { clearInterval(ka); if(!res.writableEnded) res.end(); });
    } else {
      let d = ""; r.on("data", c => d += c); r.on("end", () => res.send(d));
    }
  });
  req.setTimeout(600000, () => req.destroy());
  req.on("error", err => { if(!res.headersSent) res.status(502).json({error:{type:"proxy_error",message:err.message}}); });
  req.write(payload); req.end();
}

// ── 記錄 Claude Code 自訂標頭 ────────────────────────────────────────────
function logClaudeHeaders(req) {
  return;
  
  const beta = req.headers["anthropic-beta"];
  const sessionId = req.headers["x-claude-code-session-id"];
  const agentId = req.headers["x-claude-code-agent-id"];
  const parentAgentId = req.headers["x-claude-code-parent-agent-id"];

  if (beta) console.log(`[HEADERS] anthropic-beta: ${beta}`);
  if (sessionId) console.log(`[HEADERS] x-claude-code-session-id: ${sessionId}`);
  if (agentId) console.log(`[HEADERS] x-claude-code-agent-id: ${agentId}`);
  if (parentAgentId) console.log(`[HEADERS] x-claude-code-parent-agent-id: ${parentAgentId}`);
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.post("/v1/messages", (req, res) => {
  logClaudeHeaders(req);   // 記錄自訂標頭

  if (req.body.model) req.body.model = cleanModelName(req.body.model);
  const body = req.body;

  // 對本次請求內容進行 token 估算，供後續校正使用（僅 /api/chat 路徑會用到）
  const estimatedTokens = estimateTokens(body.system) +
                          estimateTokens(body.messages) +
                          estimateTokens(body.tools);

  const thinkType = body.thinking?.type ?? "none";
  const betaHeaders = req.headers["anthropic-beta"] || "";

  if (!FORCE_MODEL) {
    proxyToOllama("/v1/messages", body, res, body.stream ?? false);
    return;
  }

  const useThink = resolveThink(body, betaHeaders);
  const model = resolveModel(body.model, useThink) || "(from request)";
  const numCtx = getNumCtx(useThink);

  //console.log(`[${new Date().toISOString()}] thinking=${thinkType} → think=${useThink} path=${useThink ? "/v1/messages" : "/api/chat"} model=${model} ctx=${numCtx}`);

  if (useThink) {
    passthroughThink(body, res);
  } else {
    noThinkApiChat(body, res, estimatedTokens);
  }
});

// ── Token 計數端點（改良版，不使用過去的 prompt_eval_count） ──────────────
app.post("/v1/messages/count_tokens", (req, res) => {
  logClaudeHeaders(req);   // 記錄自訂標頭

  const body = req.body;
  const rawEstimate = estimateTokens(body.system) +
                      estimateTokens(body.messages) +
                      estimateTokens(body.tools);

  let tokenCount = Math.round(rawEstimate * tokenCorrectionFactor);
  const upperLimit = Math.floor(CONTEXT_WINDOW * 0.95);
  if (tokenCount > upperLimit) tokenCount = upperLimit;

  res.json({ input_tokens: tokenCount, context_window: CONTEXT_WINDOW });
});

app.get("/v1/models", (_req, res) => {
  http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (r) => {
    let d = ""; r.on("data", c => d += c);
    r.on("end", () => {
      try {
        const m = (JSON.parse(d).models ?? []).map(m => ({
          id: m.name, object: "model", created: 0, owned_by: "ollama", context_window: CONTEXT_WINDOW
        }));
        res.json({object:"list", data: m});
      } catch { res.json({object:"list", data: []}); }
    });
  }).on("error", () => res.json({object:"list", data: []}));
});

// 其他路徑直接代理給 Ollama
app.all("*", (req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const opts = {
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: req.url, method: req.method,
      headers: { ...req.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` }
    };
    // 移除可能造成問題的 hop-by-hop 標頭
    delete opts.headers["transfer-encoding"];
    delete opts.headers["connection"];

    const p = http.request(opts, (r) => {
      res.status(r.statusCode);
      for (const [k,v] of Object.entries(r.headers)) res.setHeader(k, v);
      r.pipe(res);
    });
    p.on("error", err => { if(!res.headersSent) res.status(502).json({error: err.message}); });
    if (raw.length) p.write(raw);
    p.end();
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`Ollama Think Proxy started on port ${PROXY_PORT}`);
});
