# ChatD — Realtime Messaging App

ChatD is a highly polished, clean, and modern real-time messaging application inspired by premium desktop clients (WhatsApp Web, Telegram Desktop, and Discord). Built strictly on a **Python + Flask + Flask-SocketIO + SQLite** stack, ChatD achieves modular code partitioning, desktop-grade micro-animations, and pristine layout styling without relying on heavy frontend npm frameworks.

---

## 🛠️ Technology Stack

- **Backend:** Python 3, Flask, Flask-SocketIO (using `threading` mode)
- **Frontend:** HTML5, Tailwind CSS, Vanilla ECMAScript 6 JavaScript
- **Database:** SQLite (SQL-native table schemas)
- **Realtime Layer:** WebSockets (Socket.io protocol)

---

## 📁 Project Structure

```text
chatd/
│
├── app/
│   ├── __init__.py          # Flask factory, directories & db bootloader
│   ├── routes/
│   │   ├── __init__.py      # Blueprint packager
│   │   ├── auth.py          # Session authentication, validations, and hashing
│   │   └── chats.py         # REST controllers (chats, profiles, media, uploads)
│   ├── sockets/
│   │   └── __init__.py      # SocketIO server emitters & listeners (online state, typing, seen)
│   ├── database/
│   │   └── __init__.py      # SQLite connection managers & SQL schemas
│   ├── templates/
│   │   ├── login.html       # Authentication window (Login/Signup toggle)
│   │   └── chat.html        # Main messaging dashboard layouts
│   ├── static/
│   │   ├── css/
│   │   │   └── styles.css   # Custom micro-animations & Wallpapers
│   │   ├── js/
│   │   │   └── app.js       # Core WebSockets actions and state managers
│   │   └── uploads/         # Active attachments and avatars store directory
│   └── utils/
│       └── __init__.py      # Standard utilities
│
├── run.py                   # Self-bootstrapping entry point
├── config.py                # Database and storage configurations
├── requirements.txt         # Package dependencies declarations
└── README.md                # System user instructions
```

---

## 💾 SQLite Database Tables

ChatD uses exactly five database tables managed natively under SQLite:
1. **`users`:** Tracks credentials, unique passwords hashes, profile avatars, status indicators, and last-seen activity timestamps.
2. **`chats`:** Direct messaging channels mapped between ascending participant IDs to resolve duplicates.
3. **`messages`:** Stores text content or metadata for attachment items, linking optional reply parent contexts, seen checkboxes state, and self-delete lists.
4. **`settings`:** Unique preference toggles for each user, including light/dark theme preference, custom canvas wallpaper theme, seen checkmarks visibility, and sound toggler.
5. **`files`:** Catalog of size and file extension labels for PDFs, ZIP files, and upload components.

---

## 🚀 Getting Started

The application is completely self-bootstrapping! If critical systems such as `pip` or dependencies are missing, the system will download them on start.

To run:
```bash
python run.py
```
Then open:
[http://localhost:3000](http://localhost:3000)
