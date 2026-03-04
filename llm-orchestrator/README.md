# LLM Orchestrator

A TypeScript-based LLM orchestrator that takes a user question, plans a multi-step research strategy, retrieves information from public sources, and produces a grounded answer with citations and a full execution trace.

## Architecture

```
User Request
     │
     ▼
┌─────────────┐     ┌───────────┐     ┌──────────────┐
│  Express     │────▶│ Orchestr. │────▶│ LLM Client   │
│  Route       │     │ Service   │     │ (Anthropic)  │
└─────────────┘     └───────────┘     └──────────────┘
                         │
                         ├──────────▶ Search Client (Tavily)
                         │
                         ├──────────▶ Retrieval Service (RAG)
                         │
                         └──────────▶ Trace Service
```

**Flow:** Plan → Execute (search/analyze in parallel where possible) → Synthesize → Respond

## Setup Instructions

### Prerequisites

- **Node.js 18+**
- An [Anthropic API key](https://console.anthropic.com/)
- A [Tavily API key](https://tavily.com/) (free tier available)

### Install

```bash
git clone <repo-url>
cd llm-orchestrator
npm install
```

### Configure Environment Variables

Copy the example env file and fill in your API keys:

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Your Anthropic API key |
| `TAVILY_API_KEY` | **Yes** | — | Your Tavily search API key |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Anthropic model to use |
| `PORT` | No | `8080` | Server port |
| `MAX_SEARCH_RESULTS` | No | `3` | Max results per search query |
| `MAX_ORCHESTRATION_STEPS` | No | `3` | Max steps the planner can create |
| `REQUEST_TIMEOUT_MS` | No | `30000` | Request timeout in milliseconds |
| `LOG_LEVEL` | No | `info` | Log level (`info` or `debug`) |

## How to Run

```bash
npm run dev
```

The server starts at `http://localhost:8080` (or your configured `PORT`).

### Available Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/orchestrate` | Submit a query and wait for full JSON response |
| `POST` | `/api/orchestrate/stream` | Submit a query and receive Server-Sent Events in real-time |
| `GET` | `/api/health` | Health check |

## Example Invocation

### Standard (full JSON response)

```bash
curl -s -X POST http://localhost:8080/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"query": "What are the main benefits of TypeScript over JavaScript?"}' | jq
```

### Streaming (Server-Sent Events)

```bash
curl -N -X POST http://localhost:8080/api/orchestrate/stream \
  -H "Content-Type: application/json" \
  -d '{"query": "What are the main benefits of TypeScript over JavaScript?"}'
```

The streaming endpoint returns events as they happen — first tokens arrive in ~1-2 seconds:

```
data: {"type":"status","message":"Planning research strategy..."}
data: {"type":"status","message":"Searching public sources..."}
data: {"type":"sources","sources":[...]}
data: {"type":"status","message":"Synthesizing answer..."}
data: {"type":"chunk","content":"Type"}
data: {"type":"chunk","content":"Script"}
data: {"type":"chunk","content":" offers"}
... (answer streams token by token)
data: {"type":"metadata","metadata":{...}}
data: {"type":"done"}
```

### Expected Response Shape

```json
{
  "requestId": "b1c2d3e4-...",
  "query": "What are the main benefits of TypeScript over JavaScript?",
  "answer": {
    "answer": "TypeScript offers several key advantages over JavaScript...",
    "citations": [
      {
        "sourceUrl": "https://...",
        "sourceTitle": "TypeScript Documentation",
        "claim": "Static typing catches errors at compile time"
      }
    ],
    "confidence": "high",
    "caveats": []
  },
  "sources": [
    {
      "url": "https://...",
      "title": "Source Title",
      "snippet": "Relevant excerpt...",
      "relevanceScore": 0.95,
      "retrievedAt": "2026-03-03T..."
    }
  ],
  "trace": {
    "requestId": "b1c2d3e4-...",
    "entries": [
      {
        "stepId": "planning",
        "stepType": "analyze",
        "description": "Generate execution plan",
        "status": "completed",
        "startTime": "...",
        "endTime": "...",
        "durationMs": 1200,
        "input": "What are the main benefits of TypeScript over JavaScript?",
        "output": "Planned 3 steps: ...",
        "sourcesFound": 0
      }
    ],
    "summary": "Executed 3 of 3 steps in 4.2s, retrieved 8 sources."
  },
  "metadata": {
    "totalDurationMs": 4200,
    "stepsExecuted": 3,
    "stepsFailed": 0,
    "sourcesRetrieved": 8,
    "llmTokensUsed": {
      "input": 3500,
      "output": 1200
    }
  }
}
```

## Tech Stack

- **Runtime:** Node.js 18+ with TypeScript (strict mode)
- **Framework:** Express 5
- **LLM Provider:** Anthropic Claude (via `@anthropic-ai/sdk`) with native streaming
- **Search Provider:** Tavily Search API (via `axios`)
- **Architecture:** Layered (Routes → Services → Clients) with constructor-based dependency injection
- **Streaming:** Server-Sent Events (SSE) for real-time response delivery
