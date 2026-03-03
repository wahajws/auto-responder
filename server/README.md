# LinkedIn Auto-Reply (Qwen) — Server & Extension

A Chrome Extension (Manifest V3) that adds an AI-powered "Auto-generate (Qwen)" button inside the LinkedIn Messaging composer. The extension calls a local Node.js backend which communicates with Alibaba's DashScope Qwen API to generate reply drafts.

---

## Architecture

```
┌──────────────────────┐     HTTP POST      ┌──────────────────────┐     HTTPS     ┌─────────────────────┐
│  Chrome Extension    │ ──────────────────► │  Node.js Backend     │ ────────────► │  DashScope Qwen API │
│  (content script)    │ localhost:3000      │  (Express server)    │               │  (Alibaba Cloud)    │
│  linkedin.com        │ ◄────────────────── │  holds API key       │ ◄──────────── │                     │
└──────────────────────┘    JSON response    └──────────────────────┘   AI response └─────────────────────┘
```

---

## Prerequisites

- **Node.js** ≥ 18
- **Google Chrome** (latest)
- **DashScope API key** from Alibaba Cloud

---

## 1. Get a DashScope API Key

1. Go to [DashScope Console](https://dashscope.console.aliyun.com/)
2. Sign up / sign in with an Alibaba Cloud account
3. Navigate to **API Keys** and create a new key
4. Copy the key — you'll need it in the next step

---

## 2. Set Up the Server

```bash
cd server/

# Copy the example env file and add your API key
cp .env.example .env
# Edit .env and set DASHSCOPE_API_KEY to your actual key
# The ALIBABA_LLM_API_BASE_URL defaults to:
#   https://dashscope-intl.aliyuncs.com/compatible-mode/v1

# Install dependencies
npm install

# Start the server
npm start
```

The server will start on `http://localhost:3000`.

You can verify it's running:

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

### Server Endpoints

| Method | Path              | Description                  |
|--------|-------------------|------------------------------|
| POST   | `/linkedin/draft` | Generate an AI reply draft   |
| GET    | `/health`         | Health check                 |

### Request Format (POST /linkedin/draft)

```json
{
  "conversation": [
    { "role": "them", "text": "Hi, are you available for a call?" },
    { "role": "me", "text": "Sure, when works for you?" }
  ],
  "tone": "professional",
  "model": "qwen-plus",
  "redact": false
}
```

### Response Format

```json
{
  "draft": "I'm available Tuesday at 2 PM or Wednesday at 10 AM. Would either work for you?"
}
```

---

## 3. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project
5. The extension icon should appear in your toolbar

---

## 4. Test on LinkedIn

1. Make sure the **server is running** (`npm start` in the `server/` folder)
2. Go to [LinkedIn Messaging](https://www.linkedin.com/messaging/)
3. Open any conversation thread
4. You should see a **"✨ Auto-generate (Qwen)"** button above the message composer
5. Click it to open the generation panel
6. Select a tone and click **"Generate Draft"**
7. Review/edit the draft in the textarea
8. Click **"Insert into Composer"** to place the text in LinkedIn's message box
9. Review the message and click LinkedIn's Send button manually

### Extension Settings

Click the extension icon in the Chrome toolbar to open settings:

- **Enabled** — Toggle the extension on/off
- **Default Tone** — Professional, Friendly, or Concise
- **Max Conversation Turns** — How many recent messages to send for context (default: 12)
- **Show "Approve & Send"** — Adds a button that inserts + sends in one click (user-triggered)

---

## 5. Troubleshooting

### "Auto-generate" button doesn't appear

- **Refresh the page.** LinkedIn is a SPA; sometimes the content script needs a fresh load.
- **Check the URL:** The extension only activates on `https://www.linkedin.com/messaging/*`
- **Check Developer Tools → Console** for `[Qwen AutoReply]` logs
- **LinkedIn DOM changes:** LinkedIn frequently updates its DOM structure. If selectors break, update the selector arrays in `content.js` (`findComposer()`, `extractConversation()`, etc.)

### CORS errors

- Make sure the server is running on `http://localhost:3000`
- The server includes CORS headers for `https://www.linkedin.com`
- If you still see CORS errors, check that no proxy or firewall is blocking localhost

### Rate limiting

The server allows 15 requests per minute per IP. If you hit the limit, wait and try again.

### "No messages found" error

- Make sure a conversation thread is open (not just the messaging sidebar)
- LinkedIn may have changed their message list CSS classes. Update the selectors in `extractConversation()` in `content.js`

### API key issues

- Verify your `DASHSCOPE_API_KEY` in `.env` is correct
- Check the server console for API error messages
- Make sure your DashScope account has the Qwen model enabled

### PII Redaction

Set `"redact": true` in the request body (or implement a UI toggle) to strip emails and phone numbers before sending conversation data to the AI.

---

## Project Structure

```
chrome-app/
├── extension/
│   ├── manifest.json      # Chrome Extension manifest (MV3)
│   ├── content.js         # Content script injected into LinkedIn
│   ├── styles.css         # Styles for injected UI components
│   ├── popup.html         # Extension popup (settings UI)
│   └── popup.js           # Settings popup logic
└── server/
    ├── package.json       # Node.js project config
    ├── server.js          # Express server with Qwen integration
    ├── .env.example       # Environment variable template
    └── README.md          # This file
```

---

## Security Notes

- The DashScope API key is **never** exposed in the extension code
- The key is stored server-side in a `.env` file (not committed to git)
- The server validates all incoming requests
- Rate limiting prevents abuse
- PII redaction is available as an option

---

## License

MIT
