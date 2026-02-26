**Interview Agent - Local Version**

Real-time assistant for technical Data Engineering interviews. It captures interview audio, automatically transcribes questions, and generates specialized technical answers using AI.PrerequisitesNode.js 18 or higherOpenAI API Key (for Whisper + GPT) — get it at platform.openai.com/api-keysQuick SetupBash# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# Edit the .env file and add your OPENAI_API_KEY

# 3. Start the app (server + frontend)
npm run dev
Access http://localhost:5173 in your browser.How to UseOpen the app in your browser (Chrome recommended).Choose the audio source:Microphone: captures ambient audio (useful if the interviewer is speaking through speakers).System Audio: captures computer output (ideal for Zoom, Google Meet, Teams). When selecting, check "Share audio" in the screen/tab selection window.The app captures audio snippets every 10 seconds, transcribes them, and generates the answer automatically.Answers appear in collapsible cards — click to expand/collapse.Use the controls to Pause, Resume, or End the session.Project Structureinterview-agent-local/
├── server/
│   ├── index.mjs          # Express Server (REST API)
│   └── setup-db.mjs       # SQLite DB setup script
├── src/
│   ├── App.jsx             # Main Interface
│   ├── api.js              # HTTP Client for backend
│   ├── useAudioCapture.js  # Audio capture hook
│   ├── main.jsx            # React entry point
│   └── index.css           # Styles (Tailwind + dark theme)
├── data/                   # SQLite Database (automatically created)
├── .env.example            # Environment variables template
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
TechnologiesComponentTechnologyFrontendReact 19 + Tailwind CSS 3 + ViteBackendExpress + SQLite (better-sqlite3)TranscriptionOpenAI Whisper APIAI AnswersOpenAI GPT-4o-miniAudioWeb Audio API + MediaRecorderEnvironment VariablesVariableRequiredDescriptionOPENAI_API_KEYYesOpenAI API KeyPORTNoServer port (default: 3001)DEFAULT_LANGUAGENoTranscription language (default: pt)Estimated Costs (OpenAI)Whisper: ~$0.006/minute of audioGPT-4o-mini: ~$0.15/1M input tokens, ~$0.60/1M output tokensA 1-hour session with 20 questions costs approximately $0.10 to $0.30.TipsUse Chrome for better compatibility with system audio capture.For system audio capture, select the browser tab where the video call is active (not the whole screen).The SQLite database is located at data/interview-agent.db and persists between sessions.To clear history, simply delete the database file.Troubleshooting"No audio track captured": When using system audio, ensure you check the "Share audio" option in the selection window."Audio permission denied": Check if the browser has permission to access the microphone in the site settings.Inaccurate transcriptions: Whisper works best with clear audio. Reduce background noise and increase the interviewer's volume.
