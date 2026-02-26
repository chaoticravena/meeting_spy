# Interview Agent: Enterprise-Ready

![Interview Agent Logo](https://via.placeholder.com/150/000000/FFFFFF?text=Interview+Agent)

## Overview

The **Interview Agent** is an intelligent AI assistant designed to optimize and enhance the technical interview process, especially focused on areas like Data Engineering. This "Enterprise-Ready" version was developed with a focus on **low latency**, **cost efficiency**, **scalability**, and a **polished user experience**, ensuring the system is robust for continuous use and in production environments.

It captures audio from conversations (microphone or system audio), transcribes questions in real-time, and generates precise and contextual technical answers, acting as an intelligent co-pilot during the interview.

## Key Features

This version incorporates the following advanced functionalities:

*   **Optimized Audio Capture (VAD):** Utilizes Voice Activity Detection (VAD) with 800ms silence detection to send only relevant speech segments, reducing transcription latency and costs.
*   **Streaming Responses:** AI responses are streamed in real-time, providing a fluid and responsive user experience where text appears as it is generated.
*   **Intelligent Semantic Cache:** Implements an in-memory and persistent (localStorage) caching system that stores answers for semantically similar questions, resulting in instant responses and significant API cost reduction.
*   **Robust Context System:** Maintains a history of the last 3 interactions (questions and answers) to provide relevant context to the AI, ensuring coherence and depth in responses.
*   **Job Profiles:** Allows creating and managing detailed job profiles, including position name, company, seniority, key skills, and job description. The AI uses this information to tailor its responses, making them highly personalized (RAG - Retrieval-Augmented Generation).
*   **Real-time Cost Tracking:** Monitors and displays the estimated cost of each interaction and the entire session, providing transparency and control over API expenditures.
*   **Stealth Mode:** A minimalist and discreet interface for use during the interview, allowing the user to focus on the conversation while the agent operates in the background.
*   **Keyboard Shortcuts:** Quick commands to pause/resume recording, activate stealth mode, and end the session, optimizing usability.
*   **Detailed Metrics:** Real-time metrics panel displaying latency, cache usage, audio bytes sent, and number of chunks processed.
*   **Session Export:** Functionality to export the complete question and answer history of a session to a Markdown file.

## Architecture

The Interview Agent follows a modern and decoupled architecture:

*   **Frontend:** Developed with **React 18**, **Vite** for fast bundling, and **Tailwind CSS** for responsive and efficient styling. Uses custom hooks to manage application state, audio capture, and caching.
*   **Backend:** Built with **Node.js** and **Express.js**, serving as a RESTful API. Manages business logic, integration with OpenAI APIs, data persistence, and response streaming.
*   **Database:** **SQLite** (`better-sqlite3`) for local and persistent storage of job profiles, interview sessions, and question/answer history. Full relational structure for flexibility and data querying.
*   **AI APIs:** Integration with **OpenAI Whisper API** for audio transcription and **OpenAI GPT-4o-mini** for response generation, with optimizations for cost and latency.

## Project Structure

```
meeting_spy/
├── server/
│   ├── index.mjs             # Express Server (REST API, AI Logic, DB)
│   └── setup-db.mjs          # SQLite initial setup script (optional)
├── src/
│   ├── App.jsx               # Main application component
│   ├── api.js                # HTTP client for backend communication
│   ├── main.jsx              # React entry point
│   ├── index.css             # Global styles (Tailwind CSS)
│   ├── useOptimizedAudioCapture.js # Audio capture hook with VAD
│   ├── useSmartCache.js      # Intelligent cache hook (frontend)
│   ├── useParallelQueue.js   # Hook for managing processing queue
│   ├── useKeyboardShortcuts.js # Hook for keyboard shortcuts
│   └── components/
│       ├── JobProfileManager.jsx # Job profile management
│       └── QACard.jsx        # Question and answer display
├── data/                     # Directory for SQLite file (automatically created)
├── .env.example              # Environment variables template
├── package.json              # Project dependencies and scripts
├── vite.config.js            # Vite configuration
├── tailwind.config.js        # Tailwind CSS configuration
└── postcss.config.js         # PostCSS configuration
```

## Setup and Installation

### Prerequisites

*   **Node.js** (version 18 or higher)
*   **npm** (Node.js package manager)
*   **Git**
*   **OpenAI API Key**

### Steps to Run Locally

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/chaoticravena/meeting_spy.git
    cd meeting_spy
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the project root (by copying `.env.example`) and add your OpenAI key:
    ```bash
    cp .env.example .env
    ```
    Edit the `.env` file:
    ```
    OPENAI_API_KEY=your_openai_secret_key_here
    PORT=3001 # Optional, backend server port
    DEFAULT_LANGUAGE=en # Optional, default language for transcription (e.g., en, pt)
    ```

4.  **Create Data Directory:**
    The SQLite database will be created automatically, but the `data/` directory needs to exist:
    ```bash
    mkdir data
    ```

5.  **Start the Application:**
    This command will start both the backend server and the frontend development server simultaneously:
    ```bash
    npm run dev
    ```

    The application will be accessible at `http://localhost:5173` (or the port indicated by Vite).

### Running in Production (Build)

To generate an optimized build for production:

```bash
npm run build
```

After the build, you can start the production server:

```bash
npm run server
```

The frontend will be served by the same Express server, usually at `http://localhost:3001`.

## Usage

1.  **Select a Job Profile:** On the initial screen, create or select a "Job Profile" to contextualize the AI's responses.
2.  **Start the Session:** Choose between "System Audio" (to capture audio from online meetings) or "Microphone" (for ambient audio).
3.  **Interact:** Ask questions. The agent will transcribe and respond in real-time.
4.  **Stealth Mode:** Activate the discreet mode (`Ctrl+H`) for a minimalist interface during the interview.
5.  **Control:** Use the pause/resume buttons or keyboard shortcuts (`Ctrl+Space` to pause/resume, `Esc` to stop).
6.  **Export:** At the end of the session, export the complete history to Markdown.


