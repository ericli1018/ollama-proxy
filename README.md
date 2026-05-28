# Ollama Proxy

讓 Claude Code 透過 Anthropic API 協定連線到本地 Ollama，實現離線 AI 開發。

這個 Proxy 在 Claude Code 和 Ollama 之間架設一層橋梁，將 Anthropic API 請求轉譯為 Ollama 能理解的格式，同時支援 think 模式切換、工具呼叫修復和即時串流轉譯。

## Features

- **Anthropic → Ollama 協議轉譯** — 將 `/v1/messages` 請求轉譯為 Ollama 的 `/api/chat` 或 `/v1/messages` 端點
- **Think 模式自動切換** — 根據 `thinking` 設定和關鍵字（支援中英文思考觸發詞）自動選擇 think/non-think 路徑
- **工具呼叫修復** — 自動修正 Ollama 回傳的工具呼叫格式，確保 Claude Code 工具（Bash、Read、Write、Edit 等）正常運作
- **即時串流轉譯** — 將 Ollama 的 NDJSON 串流即時轉為 Anthropic SSE 格式，文字即時輸出，工具呼叫完整緩衝後送出
- **Token 估算端點** — 實作 `/v1/messages/count_tokens`，讓 Claude Code 能正確管理上下文窗口
- **雙模型支援** — 可為 think 和 non-think 模式分別指定不同的 Ollama 模型

## Quick Start

### 1. 安裝依賴

```bash
npm install
```

### 2. 設定環境變數

```bash
export OLLAMA_PROXY_PORT=11435
export OLLAMA_PROXY_OLLAMA_HOST=localhost
export OLLAMA_PROXY_OLLAMA_PORT=11434
export OLLAMA_PROXY_OLLAMA_MODEL=qwen3.6:27b-q4_K_M-cc
export OLLAMA_PROXY_NUM_CTX=32768
```

### 3. 啟動 Proxy

```bash
node index.js
```

Proxy 會在 `http://localhost:11435` 上監聽。

## Configuration

| 環境變數 | 預設值 | 說明 |
|---|---|---|
| `OLLAMA_PROXY_PORT` | `11435` | Proxy 監聽的埠號 |
| `OLLAMA_PROXY_OLLAMA_HOST` | `localhost` | Ollama 伺服器位址 |
| `OLLAMA_PROXY_OLLAMA_PORT` | `11434` | Ollama 伺服器埠號 |
| `OLLAMA_PROXY_OLLAMA_MODEL` | `(空)` | 預設模型名稱 |
| `OLLAMA_PROXY_OLLAMA_MODEL_THINK` | `(空)` | Think 模式專用模型 |
| `OLLAMA_PROXY_NUM_CTX` | `32768` | 上下文窗口大小 |
| `OLLAMA_PROXY_NUM_CTX_THINK` | (同上) | Think 模式的上下文窗口 |

### 雙模型設定（可選）

為 think 和一般模式使用不同模型：

```bash
export OLLAMA_PROXY_OLLAMA_MODEL=qwen3.6:35b-a3b-q4_K_M-cc
export OLLAMA_PROXY_OLLAMA_MODEL_THINK=qwen3.6:27b-q4_K_M-cc
export OLLAMA_PROXY_NUM_CTX=131072
export OLLAMA_PROXY_NUM_CTX_THINK=204800
```

## Integrating with Claude Code

### 方式一：Hook 自動啟動（推薦）

在 `~/.claude/settings.json` 中新增 SessionStart hook，讓 Proxy 在每次 Claude Code 啟動時自動運行：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/ollama-proxy/start_ollama_proxy.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

然後在 Claude Code 的 shell 環境中設定：

```bash
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export ANTHROPIC_AUTH_TOKEN="ollama"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_BASE_URL=http://localhost:11435
export ANTHROPIC_MODEL=claude-sonnet-4-6
```

### 方式二：直接連線 Ollama

若 Ollama 已支援 OpenAI 相容的 `/v1/messages` 端點，可跳過 Proxy 直接連線：

```bash
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_MODEL=qwen3.6:35b-a3b-q4_K_M
```

> **注意**：直接連線不支援工具呼叫修復和 think 模式切換等功能。

## How It Works

```
Claude Code  →  Proxy (port 11435)  →  Ollama (port 11434)
   (Anthropic API)    (協議轉譯)        (本地推理)
```

1. Claude Code 發送 Anthropic API 格式的請求到 Proxy
2. Proxy 根據 `thinking` 設定判斷路由：
   - **Think 模式** → 直接轉發至 Ollama 的 `/v1/messages`（OpenAI 相容端點）
   - **一般模式** → 轉譯為 Ollama 的 `/api/chat` 格式
3. Ollama 回傳的串流回應被即時轉譯為 Anthropic SSE 格式
4. 工具呼叫在串流結束後一次性送出，確保格式完整正確

## License

MIT
