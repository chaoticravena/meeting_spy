# Interview Agent - Local Version

Real-time assistant for **Data Engineering** technical interviews. It captures interview audio, automatically transcribes questions, and generates specialized technical answers using AI.

## Prerequisites

- **Node.js** 18 or higher
- **OpenAI API Key** (for Whisper + GPT) — get it at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

## Quick Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# Edit the .env file and add your OPENAI_API_KEY

# 3. Start the app (server + frontend)
npm run dev
```

Access **http://localhost:5173** in your browser.

## How to Use

1. Open the app in your browser (Chrome recommended).
2. Choose the audio source:
   - **Microphone**: captures ambient audio (useful if the interviewer is speaking through speakers).
   - **System Audio**: captures computer output (ideal for Zoom, Google Meet, Teams). When selecting, check **"Share audio"** in the screen/tab selection window.
3. The app captures audio snippets every 10 seconds, transcribes them, and generates the answer automatically.
4. Answers appear in collapsible cards — click to expand/collapse.
5. Use the controls to **Pause**, **Resume**, or **End** the session.

## Project Structure

```text
interview-agent-local/
├── server/
│   ├── index.mjs        # Express Server (REST API)
│   └── setup-db.mjs     # SQLite DB setup script
├── src/
│   ├── App.jsx          # Main Interface
│   ├── api.js           # HTTP Client for backend
│   ├── useAudioCapture.js # Audio capture hook
│   ├── main.jsx         # React entry point
│   └── index.css        # Styles (Tailwind + dark theme)
├── data/                # SQLite Database (automatically created)
├── .env.example         # Environment variables template
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

## Technologies

| Component | Technology |
|---|---|
| Frontend | React 19 + Tailwind CSS 3 + Vite |
| Backend | Express + SQLite (better-sqlite3) |
| Transcription | OpenAI Whisper API |
| AI Answers | OpenAI GPT-4o-mini |
| Audio | Web Audio API + MediaRecorder |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI API Key |
| `PORT` | No | Server port (default: 3001) |
| `DEFAULT_LANGUAGE` | No | Transcription language (default: pt) |

## Estimated Costs (OpenAI)

- **Whisper**: ~$0.006/minute of audio
- **GPT-4o-mini**: ~$0.15/1M input tokens, ~$0.60/1M output tokens
- A 1-hour session with 20 questions costs approximately **$0.10 to $0.30**.

## Tips

- Use **Chrome** for better compatibility with system audio capture.
- For system audio capture, select the **browser tab** where the video call is active (not the whole screen).
- The SQLite database is located at `data/interview-agent.db` and persists between sessions.
- To clear history, simply delete the database file.

## Troubleshooting

**"No audio track captured"**: When using system audio, ensure you check the "Share audio" option in the selection window.

**"Audio permission denied"**: Check if the browser has permission to access the microphone in the site settings.

**Inaccurate transcriptions**: Whisper works best with clear audio. Reduce background noise and increase the interviewer's volume.
