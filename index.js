/**
 * ollama-proxy — Hybrid think-control proxy for Claude Code + Ollama
 * ==================================================================
 * think=true  → /v1/messages + thinking:enabled
 * think=false → /api/chat   + think:false
 *              → server tool 偵測到時切換 /v1/messages
 *              → tool_calls 偵測到時 retry /v1/messages
 *              → FORCE_MODEL_THINK 有設時直接 bypass /v1/messages
 *
 * ENV:
 * OLLAMA_PROXY_OLLAMA_HOST, OLLAMA_PROXY_OLLAMA_PORT
 * OLLAMA_PROXY_OLLAMA_MODEL, OLLAMA_PROXY_OLLAMA_MODEL_THINK
 * OLLAMA_PROXY_NUM_CTX, OLLAMA_PROXY_NUM_CTX_THINK, OLLAMA_PROXY_CONTEXT_WINDOW
 */
const express = require("express");
const http    = require("http");

const OLLAMA_HOST       = process.env.OLLAMA_PROXY_OLLAMA_HOST  || "localhost";
const OLLAMA_PORT       = parseInt(process.env.OLLAMA_PROXY_OLLAMA_PORT   || "11434");
const PROXY_PORT        = parseInt(process.env.OLLAMA_PROXY_PORT          || "11435");
const FORCE_MODEL       = process.env.OLLAMA_PROXY_OLLAMA_MODEL || "";
const FORCE_MODEL_THINK = process.env.OLLAMA_PROXY_OLLAMA_MODEL_THINK  || "";
const NUM_CTX           = parseInt(process.env.OLLAMA_PROXY_NUM_CTX       || "32768");
const NUM_CTX_THINK     = parseInt(process.env.OLLAMA_PROXY_NUM_CTX_THINK || process.env.OLLAMA_PROXY_NUM_CTX || "32768");
const KEEPALIVE_MS      = 15_000;
const CONTEXT_WINDOW    = parseInt(process.env.OLLAMA_PROXY_CONTEXT_WINDOW || String(NUM_CTX));

// 快取上一輪 Ollama 實際 token 數，供 count_tokens 使用
let lastPromptEvalCount = 0;

// ── Logging ───────────────────────────────────────────────────────────────────
function ts()  { return new Date().toISOString(); }
function newConnId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function log(connId, ...args) {
  const prefix = connId ? `[${ts()}][${connId}]` : `[${ts()}]`;
  console.log(prefix, ...args);
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb" }));

// ── 輔助函數 ──────────────────────────────────────────────────────────────────
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

// ── Think 決策 ────────────────────────────────────────────────────────────────
function resolveThink(body) {
  const t = body.thinking;
  if (!t) return false;

  if (t.type === "enabled") return (t.budget_tokens ?? 0) > 0;

  if (t.type === "adaptive") {
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === "user");
    const text = typeof lastUser?.content === "string"
      ? lastUser.content
      : (lastUser?.content ?? []).filter(b => b.type === "text").map(b => b.text).join(" ");
    const lower = text.toLowerCase();

    const EN_THINK    = ["ultrathink","think harder","think very hard","think really hard","think super hard","think intensely","think longer","megathink","think hard","think about it","think a lot","think deeply","think more","think carefully","think step by step"];
    const ZH_TW_THINK = ["深思","深入思考","深度思考","仔細思考","認真思考","好好想想","仔細分析","深入分析","全面分析","徹底分析","深入研究","仔細研究","用心思考","審慎思考","好好思考","思考看看","好好分析","分析一下","想清楚","想仔細","仔細想","思考","想想","分析"];
    const ZH_CN_THINK = ["深思","深入思考","深度思考","仔细思考","认真思考","好好想想","仔细分析","深入分析","全面分析","彻底分析","深入研究","仔细研究","用心思考","慎重思考","多想一会","多想一想","好好思考","好好分析","分析一下","想清楚","想仔细","仔细想","思考","想想","分析"];
    const JA_THINK    = ["じっくり考えて","深く考えて","よく考えて","慎重に考えて"];

    const matched = [...EN_THINK, ...ZH_TW_THINK, ...ZH_CN_THINK, ...JA_THINK].find(kw => lower.includes(kw));
    if (matched) log(null, `[KEYWORD] matched="${matched}"`);
    return !!matched;
  }
  return false;
}

// ── Token 估算 ────────────────────────────────────────────────────────────────
function estimateTokens(val) {
  if (!val) return 0;
  if (typeof val === "string") {
    const ascii    = (val.match(/[\x00-\x7F]/g) || []).length;
    const nonAscii = val.length - ascii;
    return Math.ceil(ascii / 4) + Math.ceil(nonAscii / 1.5);
  }
  if (Array.isArray(val)) return val.reduce((s, v) => s + estimateTokens(v), 0);
  if (typeof val === "object") { try { return estimateTokens(JSON.stringify(val)); } catch { return 0; } }
  return 0;
}

// ── Server tool 偵測 ──────────────────────────────────────────────────────────
const ANTHROPIC_SERVER_TOOLS = new Set(["web_search","web_fetch","code_execution"]);
function isServerTool(t) {
  if (t.type && /^(web_search|web_fetch|code_execution)_/.test(t.type)) return true;
  return ANTHROPIC_SERVER_TOOLS.has(t.name);
}

// ── think=true：直接透傳 /v1/messages ─────────────────────────────────────────
function passthroughThink(body, res, connId) {
  const model      = resolveModel(body.model, true);
  const numCtx     = getNumCtx(true);
  const budgetTokens = body.thinking?.budget_tokens ?? 16000;
  const fixed = {
    ...body,
    model,
    thinking: { type: "enabled", budget_tokens: budgetTokens },
    options:  { ...(body.options || {}), num_ctx: numCtx },
  };
  log(connId, `→ /v1/messages  ctx=${numCtx}  budget_tokens=${budgetTokens}`);
  proxyToOllama("/v1/messages", fixed, res, body.stream ?? false, connId);
}

/** think=false fallback：直接 bypass 到 /v1/messages（無 thinking 參數） */
function passthroughV1Messages(body, res, model, connId) {
  const fixed = { ...body, model: model || resolveModel(body.model, false) };
  delete fixed.thinking;
  log(connId, `→ /v1/messages (fallback, no think)`);
  proxyToOllama("/v1/messages", fixed, res, body.stream ?? false, connId);
}

// ── 格式轉換：Anthropic → Ollama /api/chat ────────────────────────────────────
function toOllamaMessages(messages, system) {
  const result = [];
  if (system) {
    const sys = Array.isArray(system) ? system.map(b => b.text ?? "").join(" ") : system;
    if (sys.trim()) result.push({ role: "system", content: sys });
  }
  for (const m of messages) {
    const role    = m.role ?? "user";
    const content = m.content;
    if (typeof content === "string") {
      if (content.trim()) result.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const text  = content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
      const tools = content.filter(b => b.type === "tool_use");
      const msg   = { role: "assistant", content: text };
      if (tools.length > 0) {
        msg.tool_calls = tools.map(b => ({
          id: b.id ?? "",
          function: { name: b.name, arguments: b.input ?? {} },
        }));
      }
      result.push(msg);
      continue;
    }

    const text    = content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    const results = content.filter(b => b.type === "tool_result");
    const images  = content
      .filter(b => b.type === "image" && b.source?.type === "base64")
      .map(b => b.source.data ?? "").filter(Boolean);

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
      const match   = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
                              .find(b => b.type === "tool_use" && b.id === tr.tool_use_id);
      if (match?.name) toolMsg.tool_name = match.name;
      result.push(toolMsg);
    }
    if (!text && results.length === 0) result.push({ role: "user", content: "" });
  }
  return result;
}

function toOllamaTools(tools = []) {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } },
  }));
}

// ── Tool call 修復 ────────────────────────────────────────────────────────────
const KNOWN_TOOLS = new Set(["Agent","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","ListMcpResourcesTool","LSP","NotebookEdit","Read","ReadMcpResourceTool","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WaitForMcpServers","WebFetch","WebSearch","TodoWrite","Write"]);
const SHELL_RE = /^(find|ls|cat|grep|echo|cd|mkdir|rm|mv|cp|touch|chmod|curl|wget|git|npm|node|python|pip|sed|awk|sort|head|tail|wc|ps|which|stat)\b/;

function fixToolCall(rawName, rawInput) {
  const clean = rawName.replace(/<\/?\w[^>]*>/g, "").trim();
  let name = clean, input = rawInput;
  if (!KNOWN_TOOLS.has(clean) && !clean.startsWith("mcp__") && (SHELL_RE.test(clean) || clean.includes(" "))) {
    name  = "Bash";
    input = { command: clean.replace(/<\/parameter[\s\S]*$/, "").trim() };
  }
  if (typeof input !== "object" || input === null) return { name, input };

  switch (name) {
    case "Bash": {
      const cmd = input.command ?? input.code ?? input.cmd ?? input.script ?? input.shell;
      const out = { command: cmd ?? "" };
      if (input.timeout !== undefined) out.timeout = input.timeout;
      return { name, input: out };
    }
    case "Read": {
      const fp = input.file_path ?? input.path ?? input.file ?? input.filepath ?? input.filename;
      const out = { file_path: fp ?? "" };
      if (input.offset !== undefined) out.offset = input.offset;
      if (input.limit  !== undefined) out.limit  = input.limit;
      return { name, input: out };
    }
    case "Write": {
      const fp      = input.file_path ?? input.path ?? input.file ?? input.filepath;
      const content = input.content   ?? input.text ?? input.data ?? input.body;
      return { name, input: { file_path: fp ?? "", content: content ?? "" } };
    }
    case "Edit": {
      const fp  = input.file_path ?? input.path ?? input.file ?? input.filepath;
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
      for (const [k, v] of Object.entries(input)) {
        if (k !== "pattern" && GREP_KEYS.has(k)) out[k] = v;
      }
      return { name, input: out };
    }
    case "WebFetch": {
      const url    = input.url    ?? input.link ?? input.href ?? "";
      const prompt = input.prompt ?? input.query ?? input.question ?? input.instruction ?? "Summarize the content";
      return { name, input: { url, prompt } };
    }
    case "WebSearch": {
      const query = input.query ?? input.search ?? input.q ?? "";
      return { name, input: { query } };
    }
    case "AskUserQuestion": {
      // FIX: questions 可能是字串或非陣列，一律 normalize 成陣列
      const raw = input.questions ?? input.prompts ?? input.items ?? [];
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const questions = arr.map((q, i) => {
        if (typeof q === "string") {
          return { question: q, header: `Q${i+1}`, multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] };
        }
        const questionText = q.question ?? q.text ?? q.prompt ?? q.content ?? q.message ?? "";
        const header       = String(q.header ?? q.title ?? q.label ?? q.tag ?? q.name ?? `Q${i+1}`).slice(0, 12);
        const multiSelect  = q.multiSelect ?? q.multi_select ?? q.multiple ?? q.allowMultiple ?? false;
        const rawOptions   = q.options ?? q.choices ?? q.answers ?? [];
        const options      = (Array.isArray(rawOptions) ? rawOptions : [rawOptions]).map(opt => {
          if (typeof opt === "string") return { label: opt.slice(0, 30), description: opt };
          return { label: String(opt.label ?? opt.text ?? opt.value ?? opt.name ?? "").slice(0, 30), description: opt.description ?? opt.desc ?? "" };
        });
        while (options.length < 2) options.push({ label: `Option ${options.length + 1}`, description: "" });
        return { question: questionText, header, multiSelect, options: options.slice(0, 4) };
      });
      return { name, input: { questions } };
    }
    case "ExitPlanMode": {
      const plan = input.plan ?? input.content ?? input.text ?? input.description ?? input.summary ?? input.response ?? "";
      return { name, input: { plan } };
    }
    case "TodoWrite": {
      const rawTodos = Array.isArray(input.todos ?? input.tasks ?? input.items) ? (input.todos ?? input.tasks ?? input.items) : [];
      const VALID_STATUS = new Set(["pending","in_progress","completed"]);
      const STATUS_MAP   = { todo:"pending", not_started:"pending", open:"pending", doing:"in_progress", active:"in_progress", wip:"in_progress", working:"in_progress", done:"completed", complete:"completed", finished:"completed", closed:"completed" };
      const todos = rawTodos.map(t => {
        const content   = t.content ?? t.task ?? t.title ?? t.text ?? t.description ?? t.name ?? "";
        const rawStatus = (t.status ?? t.state ?? "pending").toLowerCase().replace(/[-\s]/g, "_");
        const status    = VALID_STATUS.has(rawStatus) ? rawStatus : (STATUS_MAP[rawStatus] ?? "pending");
        const activeForm = t.activeForm ?? t.active_form ?? t.active ?? content;
        return { content, status, activeForm };
      });
      return { name, input: { todos } };
    }
    case "Agent": {
      const prompt       = input.prompt ?? input.task ?? input.instructions ?? input.content ?? input.message ?? "";
      const description  = input.description ?? input.title ?? input.summary ?? input.name ?? prompt.slice(0, 40);
      const subagent_type = input.subagent_type ?? input.agent_type ?? input.type ?? input.agent ?? input.mode ?? "general-purpose";
      return { name, input: { prompt, description, subagent_type } };
    }
    case "NotebookEdit": {
      const np  = input.notebook_path ?? input.path ?? input.file_path ?? "";
      const out = { ...input };
      if (np && !out.notebook_path) { out.notebook_path = np; delete out.path; delete out.file_path; }
      return { name, input: out };
    }
    default:
      return { name, input };
  }
}

// ── Streaming 轉換：Ollama NDJSON → Anthropic SSE ─────────────────────────────
function streamToAnthropic(ollamaStream, res, model, connId, startTime) {
  const msgId = `msg_${Math.random().toString(36).slice(2, 18)}`;
  let localInputTokens = 0, localOutputTokens = 0;

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sse = (e, d) => { if (!res.writableEnded) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); };

  sse("message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

  const ka   = setInterval(() => { if (!res.writableEnded) res.write(": keep-alive\n\n"); }, KEEPALIVE_MS);
  const done = () => { clearInterval(ka); if (!res.writableEnded) res.end(); };

  let buf = "", textBlockStarted = false;
  const toolCallMap = new Map();

  ollamaStream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const p   = JSON.parse(line);
        const msg = p.message || {};

        if (p.done) {
          localInputTokens  = p.prompt_eval_count ?? 0;
          localOutputTokens = p.eval_count ?? 0;
          lastPromptEvalCount = localInputTokens;  // 更新快取供 count_tokens 使用
        }

        const deltaText = msg.content || "";
        if (deltaText) {
          if (!textBlockStarted) {
            sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            textBlockStarted = true;
          }
          sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: deltaText } });
        }

        for (let i = 0; i < (msg.tool_calls || []).length; i++) {
          const tc = msg.tool_calls[i];
          toolCallMap.set(tc.function?.index ?? i, { id: tc.id, name: tc.function?.name || "", arguments: tc.function?.arguments || {} });
        }
      } catch {}
    }
  });

  ollamaStream.on("end", () => {
    if (textBlockStarted) sse("content_block_stop", { type: "content_block_stop", index: 0 });

    let toolIndex = textBlockStarted ? 1 : 0;
    for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
      const { name, input } = fixToolCall(tc.name, tc.arguments);
      const toolId = tc.id || `toolu_${Math.random().toString(36).slice(2, 14)}`;
      log(connId, `[TOOL] ${name}  id=${toolId}  args=${JSON.stringify(input).slice(0, 100)}`);
      sse("content_block_start", { type: "content_block_start", index: toolIndex, content_block: { type: "tool_use", id: toolId, name, input: {} } });
      sse("content_block_delta", { type: "content_block_delta", index: toolIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      sse("content_block_stop",  { type: "content_block_stop",  index: toolIndex });
      toolIndex++;
    }

    const stopReason = toolCallMap.size > 0 ? "tool_use" : "end_turn";
    sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: localInputTokens, output_tokens: localOutputTokens } });
    sse("message_stop", { type: "message_stop" });

    const elapsed = Date.now() - startTime;
    log(connId, `◀ END  reason=${stopReason}  elapsed=${elapsed}ms  in=${localInputTokens}  out=${localOutputTokens}`);
    done();
  });

  ollamaStream.on("error", (e) => {
    log(connId, `[STREAM ERROR]`, e.message);
    done();
  });
}

// ── noThinkApiChat ────────────────────────────────────────────────────────────
function noThinkApiChat(body, res, connId, startTime) {
  const model    = resolveModel(body.model, false);
  const isStream = body.stream ?? false;
  const numCtx   = getNumCtx(false);
  const tools    = body.tools ?? [];
  let system = body.system ?? "";
  if (Array.isArray(system)) system = system.map(b => b.text ?? "").join(" ");

  // ① 兩個模型都設定 → think=false 也 bypass 到 /v1/messages
  if (FORCE_MODEL_THINK) {
    log(connId, `[BYPASS] both models set → /v1/messages`);
    passthroughV1Messages(body, res, model, connId);
    return;
  }

  // ② server tool 偵測 → 切換 /v1/messages（讓 Ollama middleware 執行搜尋）
  if (tools.some(isServerTool)) {
    log(connId, `[SERVER TOOL] detected → switching to /v1/messages`);
    passthroughV1Messages(body, res, model, connId);
    return;
  }

  // ③ 走 /api/chat + think:false，緩衝後偵測 tool_calls
  const ollamaBody = {
    model,
    messages: toOllamaMessages(body.messages ?? [], system),
    think:    false,
    stream:   isStream,
    options:  { num_predict: body.max_tokens ?? 8192, num_ctx: numCtx },
    ...(tools.length > 0 ? { tools: toOllamaTools(tools) } : {}),
  };

  log(connId, `→ /api/chat  ctx=${numCtx}`);

  const payload = JSON.stringify(ollamaBody);
  const options = {
    hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/chat", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  };

  const req = http.request(options, (ollamaRes) => {
    // Streaming：緩衝全部 chunks，done 時判斷有無 tool_calls
    if (isStream) {
      const bufChunks = [];
      let   bufStr    = "";

      ollamaRes.on("data", (c) => { bufChunks.push(c); bufStr += c.toString(); });
      ollamaRes.on("end", () => {
        // 掃描所有 chunk（不只 done）找 tool_calls
        const hasTools = bufStr.split("\n").some(line => {
          try { return (JSON.parse(line).message?.tool_calls ?? []).length > 0; } catch { return false; }
        });

        if (hasTools) {
          log(connId, `[TOOL RETRY] tool_calls detected → retrying with /v1/messages`);
          passthroughV1Messages(body, res, model, connId);
        } else {
          // 把緩衝的 Ollama NDJSON stream 轉成 Anthropic SSE
          const { Readable } = require("stream");
          const fakeStream   = Readable.from(bufChunks);
          streamToAnthropic(fakeStream, res, model, connId, startTime);
        }
      });

    // Non-streaming：收完再判斷
    } else {
      let bufStr = "";
      ollamaRes.on("data", (c) => { bufStr += c.toString(); });
      ollamaRes.on("end", () => {
        try {
          const lines       = bufStr.split("\n").filter(l => l.trim());
          const toolCallMap = new Map();
          let fullText = "", inputTokens = 0, outputTokens = 0;

          for (const line of lines) {
            const p = JSON.parse(line);
            fullText += p.message?.content || "";
            for (let i = 0; i < (p.message?.tool_calls || []).length; i++) {
              const tc = p.message.tool_calls[i];
              toolCallMap.set(tc.function?.index ?? i, { id: tc.id, name: tc.function?.name || "", arguments: tc.function?.arguments || {} });
            }
            if (p.done) { inputTokens = p.prompt_eval_count ?? 0; outputTokens = p.eval_count ?? 0; lastPromptEvalCount = inputTokens; }
          }

          if (toolCallMap.size > 0) {
            log(connId, `[TOOL RETRY] tool_calls detected → retrying with /v1/messages`);
            passthroughV1Messages(body, res, model, connId);
            return;
          }

          const blocks = [];
          if (fullText) blocks.push({ type: "text", text: fullText });
          res.json({
            id: `msg_${Math.random().toString(36).slice(2, 18)}`, type: "message", role: "assistant", model,
            content: blocks, stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          const elapsed = Date.now() - startTime;
          log(connId, `◀ END  reason=end_turn  elapsed=${elapsed}ms  in=${inputTokens}  out=${outputTokens}`);
        } catch (err) {
          log(connId, `[JSON PARSE ERROR]`, err.message);
          if (!res.headersSent) res.status(500).json({ error: "Failed to parse Ollama response" });
        }
      });
    }
  });

  req.setTimeout(300_000, () => req.destroy());
  req.on("error", (err) => {
    log(connId, `[ERROR]`, err.message);
    if (!res.headersSent) res.status(502).json({ error: { type: "proxy_error", message: err.message } });
  });
  req.write(payload);
  req.end();
}

// ── proxyToOllama：透傳到 /v1/messages ───────────────────────────────────────
function proxyToOllama(path, body, res, isStream, connId) {
  const startTime = Date.now();
  const payload   = JSON.stringify(body);
  const options   = {
    hostname: OLLAMA_HOST, port: OLLAMA_PORT, path, method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  };

  const req = http.request(options, (r) => {
    res.status(r.statusCode);
    for (const [k, v] of Object.entries(r.headers)) {
      if (!["transfer-encoding","connection"].includes(k.toLowerCase())) res.setHeader(k, v);
    }
    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      const ka = setInterval(() => { if (!res.writableEnded) res.write(": keep-alive\n\n"); }, KEEPALIVE_MS);
      r.on("data", c => { if (!res.writableEnded) res.write(c); });
      r.on("end",  () => { clearInterval(ka); if (!res.writableEnded) res.end(); log(connId, `◀ END  elapsed=${Date.now()-startTime}ms`); });
    } else {
      let d = "";
      r.on("data", c => d += c);
      r.on("end",  () => { res.send(d); log(connId, `◀ END  elapsed=${Date.now()-startTime}ms`); });
    }
  });

  req.setTimeout(600_000, () => req.destroy());
  req.on("error", err => {
    log(connId, `[ERROR]`, err.message);
    if (!res.headersSent) res.status(502).json({ error: { type: "proxy_error", message: err.message } });
  });
  req.write(payload);
  req.end();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post("/v1/messages", (req, res) => {
  if (req.body.model) req.body.model = cleanModelName(req.body.model);
  const body      = req.body;
  const connId    = newConnId();
  const startTime = Date.now();

  // FORCE_MODEL 沒設 → 完全 bypass
  if (!FORCE_MODEL) {
    log(connId, `▶ bypass  model=${cleanModelName(body.model)}  stream=${body.stream ?? false}`);
    proxyToOllama("/v1/messages", body, res, body.stream ?? false, connId);
    return;
  }

  const useThink = resolveThink(body);
  const model    = resolveModel(body.model, useThink);
  const thinking = body.thinking?.type ?? "none";
  const effort   = body.output_config?.effort ?? "high";
  log(connId, `▶ START  model=${model}  thinking=${thinking}  effort=${effort}  think=${useThink}  stream=${body.stream ?? false}`);

  if (useThink) {
    passthroughThink(body, res, connId);
  } else {
    noThinkApiChat(body, res, connId, startTime);
  }
});

// /context 指令使用的 token 計數端點
app.post("/v1/messages/count_tokens", (req, res) => {
  const body        = req.body;
  const estimated   = estimateTokens(body.system) + estimateTokens(body.messages) + estimateTokens(body.tools);
  const tokenCount  = lastPromptEvalCount > 0 ? lastPromptEvalCount : estimated;
  const upperLimit  = Math.floor(CONTEXT_WINDOW * 0.95);
  const final       = Math.min(tokenCount, upperLimit);
  log("--CTX-", `count_tokens  ollama=${lastPromptEvalCount}  estimated=${estimated}  used=${final}  ctx_window=${CONTEXT_WINDOW}`);
  res.json({ input_tokens: final, context_window: CONTEXT_WINDOW });
});

app.get("/v1/models", (_req, res) => {
  http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (r) => {
    let d = ""; r.on("data", c => d += c);
    r.on("end", () => {
      try {
        const m = (JSON.parse(d).models ?? []).map(m => ({ id: m.name, object: "model", created: 0, owned_by: "ollama", context_window: CONTEXT_WINDOW }));
        res.json({ object: "list", data: m });
      } catch { res.json({ object: "list", data: [] }); }
    });
  }).on("error", () => res.json({ object: "list", data: [] }));
});

app.all("*", (req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const raw  = Buffer.concat(chunks);
    const opts = {
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: req.url, method: req.method,
      headers: { ...req.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
    };
    delete opts.headers["transfer-encoding"];
    delete opts.headers["connection"];
    const p = http.request(opts, (r) => {
      res.status(r.statusCode);
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      r.pipe(res);
    });
    p.on("error", err => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
    if (raw.length) p.write(raw);
    p.end();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[${ts()}] ╔════════════════════════════════════════════╗`);
  console.log(`[${ts()}] ║         ollama-proxy  starting up          ║`);
  console.log(`[${ts()}] ╚════════════════════════════════════════════╝`);
  console.log(`[${ts()}] [ENV] OLLAMA_HOST          = ${OLLAMA_HOST}`);
  console.log(`[${ts()}] [ENV] OLLAMA_PORT          = ${OLLAMA_PORT}`);
  console.log(`[${ts()}] [ENV] PROXY_PORT           = ${PROXY_PORT}`);
  console.log(`[${ts()}] [ENV] FORCE_MODEL          = ${FORCE_MODEL || "(none → full bypass)"}`);
  console.log(`[${ts()}] [ENV] FORCE_MODEL_THINK    = ${FORCE_MODEL_THINK || "(none)"}`);
  console.log(`[${ts()}] [ENV] NUM_CTX              = ${NUM_CTX}`);
  console.log(`[${ts()}] [ENV] NUM_CTX_THINK        = ${NUM_CTX_THINK}`);
  console.log(`[${ts()}] [ENV] CONTEXT_WINDOW       = ${CONTEXT_WINDOW}`);
  console.log(`[${ts()}] ─────────────────────────────────────────────`);
  console.log(`[${ts()}] think=true   → /v1/messages (bypass, Ollama 原生處理)`);
  console.log(`[${ts()}] think=false  → /api/chat + think:false`);
  console.log(`[${ts()}]   + server tool → /v1/messages`);
  console.log(`[${ts()}]   + tool_calls  → retry /v1/messages`);
  console.log(`[${ts()}]   + both models → /v1/messages bypass`);
});
