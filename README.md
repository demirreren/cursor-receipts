# Thermal Printer Server (USB)

A simple server for printing to USB thermal printers, with optional public internet access.

## Setup

1. **Install Bun** (if not already installed):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Connect your USB thermal printer** (Epson TM-m50, TM-T20II, etc.)

4. **Run the server**:
   ```bash
   bun server.ts
   ```

5. **Access the web interface**:
   - Open `http://YOUR-MAC-LOCAL-IP:9999` on any device
   - Find your IP: `ifconfig en0 | grep inet`

## Configuration

Set these environment variables when needed:

- `PRINTER_NAME` (default: `EPSON_TM_T20II`)
- `PORT` (default: `9999`)
- `PRINT_TOKEN` (optional but recommended for public access)
- `PUBLIC_BASE_URL` (optional; printed in server logs)

Example:

```bash
PRINTER_NAME=EPSON_TM_T20II PORT=9999 PRINT_TOKEN=choose-a-long-secret bun server.ts
```

## Public Internet Access (not same network)

Because the printer is USB-connected, your Mac must stay on and running this server.

### Option A: Cloudflare Tunnel (recommended)

1. Install `cloudflared`:
   ```bash
   brew install cloudflared
   ```
2. Start the printer server with a token:
   ```bash
   PRINT_TOKEN=choose-a-long-secret bun server.ts
   ```
3. Expose it publicly:
   ```bash
   cloudflared tunnel --url http://localhost:9999
   ```
4. Share the generated `https://...trycloudflare.com` URL.

Anyone with the URL + token can submit print jobs from anywhere.

### Option B: Ngrok

```bash
ngrok http 9999
```

Use the generated HTTPS URL. Keep `PRINT_TOKEN` enabled.

## Features

- USB printer support (no network required)
- Web interface for sending messages
- Image printing support
- Queue system (prints every 8 seconds)
- ESC/POS compatible thermal printers
- `GET /health` endpoint for quick status checks

## USB Setup Notes

- **macOS**: Should work out of the box

## Supported Printers

Any ESC/POS compatible thermal printer, including:
- Epson TM-m50, TM-T20II, TM-m30 series
- Star Micronics printers
- Other ESC/POS thermal printers

## Usage

1. Open the web interface on any device
2. Enter your name (optional)
3. Type a message or upload an image
4. Click "PRINT IT"
5. Your message will be queued and printed in a few seconds!


