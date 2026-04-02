# CloudHand-Mini-Term (Native Control Terminal) v0.1.0

> [!CAUTION]
> **SECURITY WARNING: This project is designed to provide remote terminal access. Using this software may expose your local terminal to the internet via the relay server. Please operate ONLY in trusted network environments and ensure your Token is kept secure. Improper configuration could lead to severe system security risks. Please proceed with caution.**

> **A highly secure, cross-network terminal solution.** It completely separates the "Control Plane" from the "Execution Plane", implemented as a Node.js tray application, specifically designed for remote AI collaboration and O&M.

## 💡 Architecture: Asymmetric Security

The core of CloudHand-Mini-Term is the **two-terminal separation** architecture, ensuring that even if the relay server is compromised, local system execution authority remains protected:

1.  **Public Relay Server**: Deployed on a public server. It acts only as a "traffic bridge" and has no PTY execution capability. It uses a "trust on first sight" Token registration mechanism and supports multiple machine connections.
2.  **Local Tray App**: Deployed on the physical machine. It runs silently in the Windows system tray and actively initiates connections to the relay server. It generates a UUID Token as a permanent identity credential upon first launch.

## 🛡️ Security Features

- **🎨 Modern Interactive UI**: Newly designed top Tabs for session management, say goodbye to crowded sidebars, supports double-click to rename.
- **⊞ Dynamic Multi-Layout**: Toggle between single-pane, 2-H, 2-V, and 4-grid modes with one click, enabling synchronized monitoring across multiple sessions.
- **🖱️ Smart Drag-and-Drop**: Drag a session Tab directly into any grid slot for instant allocation, intuitive and efficient.
- **Zero Exposure**: No public ports need to be opened on the local computer. Control is achieved entirely through an active outbound persistent connection.
- **Persistent Token Authentication**: The local machine holds a permanent UUID Token and connects directly to the relay upon startup, requiring no manual pairing.
- **Blind Login**: On the public side, requests without a valid Token receive no hints, thwarting brute-force attacks.
- **Machine Isolation**: Multiple machines can connect to the same relay simultaneously, with terminal sessions completely isolated from each other.

## 🚀 Deployment and Usage

### Step 1: Start the Public Relay (Server Side)
On your public server:
```bash
cd openclaw-skill
npm install
node relay-server.js --port=3456
```

### Step 2: Start the Local Client (Execution Side)
On your local computer (the one you want to control):
```bash
npm install
npm run dev
```
After starting, you will see the CloudHand icon in the system tray, and the **Local Settings Page** (`http://127.0.0.1:9899`) will open automatically.

### Step 3: Connect to Relay
1.  Enter a **Computer Name** in the settings page (optional, defaults to system hostname).
2.  Enter your **Relay Server Address** (e.g., `opc.example.com:3456`).
3.  Click **"Connect to Relay Server"**.
4.  Once it shows `🟢 Connected (Ready)`, you can access the terminal via the link displayed in the browser.

### Step 4: Master the Layout (NEW)
1.  **Create Sessions**: Click the "+" at the top or "＋ New" within a slot to start multiple terminals.
2.  **Switch Layouts**: Use the icons in the top-right corner to toggle between single, split, or 4-grid layouts.
3.  **Reallocate**: Drag and drop Tabs from the top into your preferred slot, or click a Tab to dispatch a session to the currently active slot.

> Subsequent restarts of the local client will automatically restore the connection using the saved Token.

### View Online Machines
```bash
curl http://RELAY_ADDRESS:3456/api/clients
# Returns: [{computer_name, connected, lastSeen}]
```

## 📂 Project Structure

- `src/`: Core logic for the tray client (Session management, WS client).
- `openclaw-skill/`: Relay server logic (HTTP/WS Server, Web UI).
- `contexts/`: Project core context documents.
- `settings.json`: Persistent configuration (Server address, Token, Computer name).

## 📄 License & Dependencies
- **Server**: `ws`, `express` (streamlined), `crypto`.
- **Tray App**: `node-pty`, `systray2`, `clipboardy`.

---
*Designed by OpenClaw, built for hackers and AI developers.*
