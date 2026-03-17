import { execSync } from "child_process";
import { serve } from "bun";
import { PNG } from "pngjs";
import sharp from "sharp";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface PrintJob {
  name?: string;
  text?: string;
  image?: {
    name: string;
    type: string;
    data: Buffer;
  };
}

let queue: PrintJob[] = [];
const PRINTER_NAME = process.env.PRINTER_NAME || "EPSON_TM_T20II";
const PORT = Number(process.env.PORT || 9999);
const PRINT_TOKEN = process.env.PRINT_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const RECEIPT_TEXT_WIDTH = 42;

// Load logo once at startup
let logoBuffer: Buffer | null = null;
const logoCandidates = [
  join(process.cwd(), "assets", "cursor_freeform.png"),
  join(process.cwd(), "assets", "logo.png"),
];
const logoPath = logoCandidates.find((candidate) => existsSync(candidate));
if (logoPath) {
  try {
    logoBuffer = readFileSync(logoPath);
    console.log(`[LOGO] Logo loaded from ${logoPath.replace(`${process.cwd()}/`, "")}`);
  } catch (err: any) {
    console.warn("[LOGO] Failed to load logo:", err?.message || err);
  }
} else {
  console.log("[LOGO] No logo found in assets/ (optional - skipping)");
  console.log("[LOGO] To add a logo, place cursor_freeform.png or logo.png in assets/");
}

async function processImage(imageData: Buffer): Promise<Buffer> {
  console.log("[IMAGE] Processing image buffer:", imageData.length, "bytes");
  
  // Get image metadata first to check orientation and dimensions
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(imageData).metadata();
    console.log("[IMAGE] Original metadata:", {
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation,
      format: metadata.format
    });
  } catch (err: any) {
    console.error("[IMAGE] Failed to read metadata:", err?.message || err);
    throw new Error(`Failed to read image metadata: ${err?.message || err}`);
  }
  
  // Printer width (thermal printers - this one is 576px wide)
  const printerWidth = 576;
  
  // Use sharp to handle rotation, resizing, and conversion all in one go
  // This ensures high-quality scaling and proper EXIF orientation handling
  let pngBuffer: Buffer;
  try {
    console.log("[IMAGE] Processing with sharp (rotation + resize + convert)...");
    
    let sharpInstance = sharp(imageData)
      .rotate(); // Auto-rotates based on EXIF orientation (fixes iPhone rotation)
    
    // Get dimensions after rotation to determine orientation
    const rotatedMetadata = await sharpInstance.metadata();
    const isPortrait = (rotatedMetadata.height || 0) > (rotatedMetadata.width || 0);
    
    console.log(`[IMAGE] After rotation: ${rotatedMetadata.width}x${rotatedMetadata.height} (${isPortrait ? 'PORTRAIT' : 'LANDSCAPE'})`);
    
    // Resize logic: Always preserve aspect ratio
    // - Portrait: Scale to fill width (576px), height scales proportionally
    // - Landscape: Scale to fit width (576px), height scales proportionally
    if (isPortrait) {
      // Portrait: Scale to printer width, maintain aspect ratio
      console.log(`[IMAGE] Portrait image: scaling to ${printerWidth}px width (preserving aspect ratio)`);
      sharpInstance = sharpInstance.resize(printerWidth, null, {
        withoutEnlargement: false,
        fit: 'inside' // Preserves aspect ratio
      });
    } else {
      // Landscape: Scale to fit width, maintain aspect ratio
      console.log(`[IMAGE] Landscape image: scaling to ${printerWidth}px width (preserving aspect ratio)`);
      sharpInstance = sharpInstance.resize(printerWidth, null, {
        withoutEnlargement: false,
        fit: 'inside' // Preserves aspect ratio
      });
    }
    
    // Convert to PNG
    pngBuffer = await sharpInstance.png().toBuffer();
    console.log("[IMAGE] Final processed image:", pngBuffer.length, "bytes");
  } catch (err: any) {
    console.error("[IMAGE] Sharp processing failed:", err?.message || err);
    throw new Error(`Failed to process image: ${err?.message || err}`);
  }
  
  // Decode PNG
  let png: PNG;
  try {
    png = PNG.sync.read(pngBuffer);
    console.log("[IMAGE] PNG decoded - FINAL SIZE:", png.width, "x", png.height);
    console.log(`[IMAGE] Width matches printer width: ${png.width === printerWidth ? 'YES ✓' : `NO ✗ (${png.width}px vs ${printerWidth}px)`}`);
  } catch (err: any) {
    console.error("[IMAGE] PNG decode failed:", err?.message || err);
    throw new Error(`Failed to decode PNG: ${err?.message || err}`);
  }
  
  // Convert to bitmap with Floyd-Steinberg dithering for better grayscale simulation
  const { width, height, data } = png;
  const bytesPerRow = Math.ceil(width / 8);
  
  // Step 1: Convert RGBA to grayscale array
  const grayscale = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3];
      
      if (alpha < 128) {
        // Transparent = white (255)
        grayscale[y * width + x] = 255;
      } else {
        // Grayscale conversion (0-255)
        grayscale[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }
  }
  
  // Step 2: Apply Floyd-Steinberg dithering
  // This distributes quantization errors to neighboring pixels
  // to create the illusion of grayscale with only black/white pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = grayscale[idx];
      
      // Quantize to black (0) or white (255)
      const newPixel = oldPixel < 128 ? 0 : 255;
      grayscale[idx] = newPixel;
      
      // Calculate quantization error
      const error = oldPixel - newPixel;
      
      // Distribute error to neighboring pixels (Floyd-Steinberg weights)
      if (x + 1 < width) {
        grayscale[idx + 1] += error * (7 / 16); // Right
      }
      if (x > 0 && y + 1 < height) {
        grayscale[idx + width - 1] += error * (3 / 16); // Bottom-left
      }
      if (y + 1 < height) {
        grayscale[idx + width] += error * (5 / 16); // Bottom
      }
      if (x + 1 < width && y + 1 < height) {
        grayscale[idx + width + 1] += error * (1 / 16); // Bottom-right
      }
    }
  }
  
  // Step 3: Convert dithered grayscale to 1bpp bitmap (MSB first)
  const bitmap = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const isBlack = grayscale[idx] < 128;
      
      if (isBlack) {
        const byteIndex = y * bytesPerRow + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8); // MSB first
        bitmap[byteIndex] |= 1 << bitIndex;
      }
    }
  }
  
  // GS v 0 command: GS v 0 m xL xH yL yH [bitmap]
  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;
  const m = 0x00; // normal mode
  
  const header = Buffer.from([
    0x1D, 0x76, 0x30, m,    // GS v 0 m
    xL, xH, yL, yH          // width (bytes), height (dots)
  ]);
  
  return Buffer.concat([header, bitmap]);
}

function wrapReceiptText(value: string, maxWidth = RECEIPT_TEXT_WIDTH): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    const words = trimmed.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        if (word.length > maxWidth) {
          for (let i = 0; i < word.length; i += maxWidth) {
            lines.push(word.slice(i, i + maxWidth));
          }
          line = "";
        } else {
          line = word;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

async function print(job: PrintJob) {
  try {
    console.log("[PRINT] Starting print job:", {
      hasName: !!job.name,
      hasText: !!job.text,
      hasImage: !!job.image,
      imageName: job.image?.name,
      imageSize: job.image?.size
    });
    
    // Build ESC/POS command buffer
    const parts: Buffer[] = [];
    
    // Initialize printer
    parts.push(Buffer.from([0x1b, 0x40])); // ESC @
    
    // Order: Logo → Text → Image (with minimal spacing)
    
    // 1. Add logo first when available
    if (logoBuffer) {
      try {
        console.log("[PRINT] Adding logo...");
        parts.push(Buffer.from("\n")); // Minimal spacing before logo
        
        // Center the logo
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // ESC a 1 (center)
        
        const logoData = await processImage(logoBuffer);
        console.log("[PRINT] Logo processed, ESC/POS size:", logoData.length, "bytes");
        parts.push(logoData);
        
        // Reset alignment to left after logo
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // ESC a 0 (left)
        parts.push(Buffer.from("\n")); // Minimal spacing after logo
      } catch (logoErr: any) {
        console.error("[PRINT] Logo processing failed:", logoErr?.message || logoErr);
        // Continue even if logo fails
      }
    }
    
    // 2. Add text (between logo and image) - styled for café receipts
    if (job.name || job.text) {
      const dividerLine = "=".repeat(RECEIPT_TEXT_WIDTH);

      parts.push(Buffer.from([0x1b, 0x61, 0x00])); // Left align
      parts.push(Buffer.from(`${dividerLine}\n`));

      // Name: Bold, larger, centered
      if (job.name) {
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // Center align
        parts.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
        parts.push(Buffer.from([0x1d, 0x21, 0x11])); // Double height + width
        parts.push(Buffer.from(job.name));
        parts.push(Buffer.from([0x1d, 0x21, 0x00])); // Normal size
        parts.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // Left align
        parts.push(Buffer.from("\n\n"));
      }

      // Project name section
      if (job.text) {
        parts.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
        parts.push(Buffer.from("BUILDING...\n"));
        parts.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
        parts.push(Buffer.from([0x1d, 0x21, 0x01])); // Double height
        for (const line of wrapReceiptText(job.text)) {
          parts.push(Buffer.from(line));
          parts.push(Buffer.from("\n"));
        }
        parts.push(Buffer.from([0x1d, 0x21, 0x00])); // Normal size
        parts.push(Buffer.from("\n"));
      }

      parts.push(Buffer.from(`${dividerLine}\n`));
      
      console.log("[PRINT] Added styled text");
    }
    
    // 3. Add image last
    if (job.image) {
      console.log("[PRINT] Processing image:", job.image.name, job.image.data.length, "bytes");
      try {
        // Center the image using ESC/POS alignment command
        // ESC a 1 = center alignment
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // ESC a 1 (center)
        
        const imageData = await processImage(job.image.data);
        console.log("[PRINT] Image processed, ESC/POS size:", imageData.length, "bytes");
        parts.push(imageData);
        
        // Reset alignment to left after image
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // ESC a 0 (left)
        parts.push(Buffer.from("\n")); // Minimal spacing after image
      } catch (imgErr: any) {
        console.error("[PRINT] Image processing failed:", imgErr?.message || imgErr);
        console.error("[PRINT] Error stack:", imgErr?.stack);
        parts.push(Buffer.from("\n[Image processing error]\n"));
      }
    }
    
    // Add newlines at end
    parts.push(Buffer.from("\n\n\n\n\n\n"));
    
    // Auto-cut paper (GS V 66 0 = partial cut, leaves small connection)
    // Use 0x41 for full cut if you prefer complete separation
    parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V 66 0
    
    // Combine all parts
    const command = Buffer.concat(parts);
    console.log("[PRINT] Total command size:", command.length, "bytes");
    
    // Send through lp -o raw
    console.log("[PRINT] Sending to printer...");
    execSync(`cat | lp -d "${PRINTER_NAME}" -o raw`, { input: command });
    console.log("[PRINT] ✓ Print command sent successfully");
    
    const preview = job.text?.slice(0, 50).replace(/\n/g, " ") || job.image ? "[image]" : "blank";
    console.log("PRINTED:", preview);
  } catch (err: any) {
    console.error("[PRINT] Print error:", err?.message || err);
    console.error("[PRINT] Error stack:", err?.stack);
  }
}

setInterval(async () => {
  if (queue.length > 0) {
    console.log("[QUEUE] ===== QUEUE PROCESSOR =====");
    console.log("[QUEUE] Processing queue,", queue.length, "job(s) waiting");
    const job = queue.shift()!;
    console.log("[QUEUE] Job details:", {
      hasName: !!job.name,
      hasText: !!job.text,
      hasImage: !!job.image,
      imageName: job.image?.name
    });
    await print(job);
    console.log("[QUEUE] ===== QUEUE PROCESSOR COMPLETE =====");
  }
}, 8000);   // one print every 8 sec = perfect pace

print({ text: "🧾 PRINTER READY – café mode activated 🧾" });

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    console.log("[HTTP] ===== REQUEST =====");
    console.log("[HTTP] Method:", req.method);
    console.log("[HTTP] Path:", url.pathname);
    console.log("[HTTP] URL:", req.url);
    
    // Handle POST /chat first (before GET route catches it)
    if (url.pathname === "/chat" && req.method === "POST") {
      console.log("[HTTP] ✓ POST /chat route matched");
      console.log("[HTTP] Content-Type:", req.headers.get("content-type"));
      console.log("[HTTP] Content-Length:", req.headers.get("content-length"));
      
      try {
        console.log("[HTTP] Starting formData() parse...");
        const fd = await Promise.race([
          req.formData(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("formData() timeout after 10s")), 10000)
          )
        ]) as FormData;
        console.log("[HTTP] ✓ Form data parsed successfully");
        
        const token = (fd.get("token") as string | null)?.trim() || req.headers.get("x-print-token")?.trim() || "";
        if (PRINT_TOKEN && token !== PRINT_TOKEN) {
          console.warn("[AUTH] Rejected print request with invalid token");
          return new Response("unauthorized", { status: 401 });
        }

        const name = fd.get("name") as string | null;
        const text = fd.get("text") as string | null;
        const image = fd.get("image") as File | null;
        
        console.log("[QUEUE] ===== FORM SUBMISSION =====");
        console.log("[QUEUE] Received form data:", {
          name: name || "(none)",
          text: text || "(none)",
          hasImage: !!image,
          imageName: image?.name,
          imageSize: image?.size,
          imageType: image?.type
        });
        
        // Convert File to Buffer if present (File objects don't serialize well in queues)
        let imageData: { name: string; type: string; data: Buffer } | undefined;
        if (image && image.size > 0) {
          try {
            console.log("[QUEUE] Converting image File to Buffer...");
            const arrayBuffer = await image.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            console.log("[QUEUE] ✓ Image converted to buffer:", buffer.length, "bytes");
            imageData = {
              name: image.name,
              type: image.type,
              data: buffer
            };
          } catch (err: any) {
            console.error("[QUEUE] ✗ Failed to convert image:", err?.message || err);
            console.error("[QUEUE] Error stack:", err?.stack);
          }
        }
        
        const job: PrintJob = {
          name: name || undefined,
          text: text || undefined,
          image: imageData,
        };
        
        if (!job.text && !job.image) {
          job.text = "blank print";
        }
        
        console.log("[QUEUE] Job created:", {
          hasName: !!job.name,
          hasText: !!job.text,
          hasImage: !!job.image,
          imageName: job.image?.name
        });
        console.log("[QUEUE] Adding job to queue. Current queue length:", queue.length);
        queue.push(job);
        console.log("[QUEUE] ✓ Job added! Queue length now:", queue.length);
        console.log("[QUEUE] ===== FORM SUBMISSION COMPLETE =====");
        return new Response("queued");
      } catch (err: any) {
        console.error("[QUEUE] ✗ Error processing form data:", err);
        console.error("[QUEUE] Error stack:", err?.stack);
        return new Response(`error processing form: ${err?.message || err}`, { status: 500 });
      }
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({
        ok: true,
        queueLength: queue.length,
        printer: PRINTER_NAME
      });
    }
    
    // Handle GET requests (show form)
    if (url.pathname === "/" || url.pathname === "/chat") {
      return new Response(`
<!DOCTYPE html>
<html lang="en-US" data-theme="dark" style="color-scheme: dark;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Send to Printer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --theme-bg: #14120b;
      --theme-text: #E4E4E4;
      --theme-card: #1a1810;
      --theme-border: hsl(0, 0%, 20%);
      --theme-border-hover: hsl(0, 0%, 25%);
      --theme-input-bg: #1a1810;
      --theme-button-bg: #E4E4E4;
      --theme-button-text: #14120b;
      --theme-button-hover: #f5f5f5;
      --theme-text-sec: rgba(228, 228, 228, 0.7);
    }
    
    html, body {
      margin: 0;
      padding: 0;
      overflow-x: hidden;
      height: 100%;
    }
    
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--theme-bg);
      color: var(--theme-text);
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      box-sizing: border-box;
      overflow-y: auto;
    }
    
    .container {
      width: 100%;
      max-width: 420px;
      box-sizing: border-box;
      padding: 0.5rem;
    }
    
    .card {
      background: var(--theme-card);
      border: 1px solid var(--theme-border);
      border-radius: 10px;
      padding: 1rem;
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.14), 0 14px 32px rgba(0, 0, 0, 0.1);
      box-sizing: border-box;
      width: 100%;
    }
    
    h1 {
      font-size: 1.125rem;
      font-weight: 600;
      text-align: center;
      margin-bottom: 0.75rem;
      margin-top: 0;
      color: var(--theme-text);
    }
    
    .form-group {
      margin-bottom: 0.625rem;
    }
    
    label {
      display: block;
      font-size: 0.875rem;
      color: var(--theme-text-sec);
      margin-bottom: 0.5rem;
      font-weight: 500;
    }
    
    input[type="text"],
    textarea {
      width: 100%;
      padding: 0.75rem;
      font-size: 0.9375rem;
      background: var(--theme-input-bg);
      border: 1px solid var(--theme-border);
      border-radius: 6px;
      color: var(--theme-text);
      font-family: inherit;
      transition: border-color 0.2s, background-color 0.2s;
      box-sizing: border-box;
    }
    
    input[type="text"]:focus,
    textarea:focus {
      outline: none;
      border-color: var(--theme-border-hover);
      background: #1f1d15;
    }
    
    input[type="text"]::placeholder,
    textarea::placeholder {
      color: var(--theme-text-sec);
    }
    
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    
    input[type="file"] {
      width: 100%;
      padding: 0.75rem;
      font-size: 0.875rem;
      background: var(--theme-input-bg);
      border: 1px solid var(--theme-border);
      border-radius: 6px;
      color: var(--theme-text);
      cursor: pointer;
      transition: border-color 0.2s;
      box-sizing: border-box;
    }
    
    input[type="file"]:hover {
      border-color: var(--theme-border-hover);
    }
    
    input[type="file"]::file-selector-button {
      padding: 0.5rem 1rem;
      margin-right: 0.75rem;
      background: var(--theme-button-bg);
      color: var(--theme-button-text);
      border: none;
      border-radius: 4px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    
    input[type="file"]::file-selector-button:hover {
      background: var(--theme-button-hover);
    }
    
    button[type="submit"] {
      width: 100%;
      padding: 0.875rem 1.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      background: var(--theme-button-bg);
      color: var(--theme-button-text);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s, transform 0.1s;
      margin-top: 0.25rem;
      box-sizing: border-box;
    }
    
    button[type="submit"]:hover {
      background: var(--theme-button-hover);
    }
    
    button[type="submit"]:active {
      transform: scale(0.98);
    }
    
    .helper-text {
      font-size: 0.75rem;
      color: var(--theme-text-sec);
      margin-top: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Send to Printer 🧾</h1>
      <form method="POST" enctype="multipart/form-data">
        <div class="form-group">
          <label for="name">Your name</label>
          <input type="text" id="name" name="name" placeholder="Optional">
        </div>
        ${PRINT_TOKEN ? `
        <div class="form-group">
          <label for="token">Print token</label>
          <input type="password" id="token" name="token" placeholder="Required for public access" required>
        </div>
        ` : ""}
        <div class="form-group">
          <label for="text">Project name</label>
          <input type="text" id="text" name="text" placeholder="What are you building?">
        </div>
        <div class="form-group">
          <label for="image">Photo</label>
          <input type="file" id="image" name="image" accept="image/*">
          <div class="helper-text">Upload a photo from your phone</div>
        </div>
        <button type="submit">PRINT IT</button>
      </form>
    </div>
  </div>
  <script>
    document.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('text') && !fd.get('image')) {
        alert("Add project name or photo!");
        return;
      }
      const button = e.target.querySelector('button[type="submit"]');
      const originalText = button.textContent;
      button.textContent = "Printing...";
      button.disabled = true;
      try {
        await fetch("/chat", {method:"POST",body:fd});
        button.textContent = "Queued! 🧾";
        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
        }, 2000);
        e.target.reset();
      } catch (err) {
        button.textContent = "Error - Try again";
        button.disabled = false;
        setTimeout(() => {
          button.textContent = originalText;
        }, 2000);
      }
    };
  </script>
</body>
</html>
      `, { headers: { "Content-Type": "text/html" } });
    }

    console.log("[HTTP] No matching route, returning 'ok'");
    return new Response("ok");
  },
});

console.log(`OPEN THIS ON ANY PHONE → http://YOUR-MAC-LOCAL-IP:${PORT}`);
console.log("Find your IP: ifconfig en0 | grep inet → usually 192.168.x.x");
console.log(`[CONFIG] Printer: ${PRINTER_NAME}`);
console.log(`[CONFIG] Port: ${PORT}`);
if (PUBLIC_BASE_URL) {
  console.log(`[CONFIG] Public URL: ${PUBLIC_BASE_URL}`);
}
if (PRINT_TOKEN) {
  console.log("[CONFIG] Public access token is ENABLED");
}
