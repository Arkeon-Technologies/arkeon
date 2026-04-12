# Runtime Environment

What's inside the worker sandbox — pre-installed tools, file processing capabilities, image handling, and the philosophy behind making workers able to handle any input format.

## Philosophy

Workers are general-purpose agents. Users throw documents, images, data files, and code at them. The platform's job is to make sure the worker can handle whatever comes in — extract content, understand it, and turn it into structured knowledge in the graph.

Three principles:

1. **Pre-install the common stuff.** PDFs, Word docs, spreadsheets, images — these are predictable. Have the packages on the host so the worker doesn't waste iterations on `pip install`.

2. **Let workers self-install the rest.** Edge cases are unpredictable. The sandbox is configured so `pip install <package>` works without special flags. Packages install to the workspace and are available immediately.

3. **Give the LLM eyes.** If the model supports vision, the `view_image` tool sends image content directly to it. The worker can generate charts, extract frames, photograph documents, and actually see what it's working with.

## Host toolchain

Arkeon runs workers by shelling out on the host operating system. There is no Docker container to carry tools — the host has to have them. `arkeon start` checks for the required tools at boot and prints a warning listing anything missing; the API still starts, but worker shell commands will fail at run time if the binaries aren't in `PATH`.

### Required

| Tool | Purpose |
|------|---------|
| `bash` | Shell execution |
| `curl` | HTTP requests |
| `jq` | JSON processing |
| `python3` | Script execution, package management |

### Linux only

| Tool | Purpose |
|------|---------|
| `bwrap` | Bubblewrap namespace isolation for worker sandboxes |

On macOS there is no namespace isolation — the sandbox falls back to direct execution inside a workspace directory (see `packages/runtime/src/sandbox.ts`). That's fine for development but not a real security boundary, so only run untrusted worker code on Linux hosts where `bwrap` is installed.

### Install

- **macOS**: `brew install curl jq python3`
- **Debian / Ubuntu**: `sudo apt-get install bubblewrap curl jq python3 python3-pip`

### Recommended Python packages

Install these on the host so workers don't have to pip-install them on every invocation:

```bash
pip3 install --break-system-packages \
  reportlab pypdf python-docx openpyxl python-pptx \
  ebooklib beautifulsoup4 lxml \
  Pillow pandas markdown chardet
```

**Documents:**
| Package | Handles |
|---------|---------|
| `pypdf` | Reading and extracting text from PDFs |
| `reportlab` | Generating PDFs |
| `python-docx` | Reading and writing Word (.docx) files |
| `openpyxl` | Reading and writing Excel (.xlsx) files |
| `python-pptx` | Reading and writing PowerPoint (.pptx) files |

**Web and books:**
| Package | Handles |
|---------|---------|
| `ebooklib` | Reading EPUB files |
| `beautifulsoup4` | Parsing HTML and XML |
| `lxml` | Fast XML/HTML parser (used by bs4 and others) |

**Images and data:**
| Package | Handles |
|---------|---------|
| `Pillow` | Image reading, writing, resizing, format conversion |
| `pandas` | Tabular data processing (CSV, Excel, JSON) |
| `markdown` | Markdown parsing |
| `chardet` | Character encoding detection |

### Self-installing Additional Packages

The sandbox is configured with `PIP_TARGET` pointing to the workspace and `PYTHONPATH` set to include it. Workers can install additional packages without any special flags:

```python
# This just works inside the sandbox:
import subprocess
subprocess.check_call(["pip", "install", "matplotlib"])
import matplotlib.pyplot as plt
```

Or from the shell:
```bash
pip install pyyaml
python3 -c "import yaml; print(yaml.safe_load('key: value'))"
```

Packages install to the workspace directory and are automatically on the Python path. They persist for the duration of the invocation and are cleaned up after.

## Image Handling

### The `view_image` Tool

Workers with a multimodal LLM (GPT-4o, GPT-5.4-mini, etc.) can view images using the `view_image` tool. The image is base64-encoded and injected as visual content in the conversation — the LLM actually sees the image, not a text description.

**Supported formats:** PNG, JPEG, GIF, WebP

**Size limit:** 10MB (use Pillow to resize larger images first)

**How it works internally:** The Chat Completions API doesn't support images in tool results, so the agent runtime injects a follow-up user message containing the image as an `image_url` content part. This is transparent to the worker — it just calls `view_image` and sees the image.

**Use cases:**
- Analyzing charts and diagrams
- Reading text from scanned documents
- Extracting information from screenshots
- Verifying generated visualizations
- Processing photographs of physical documents

### Generating Images

Workers can generate images using Pillow (pre-installed) or matplotlib (self-install). Common patterns:

- **Charts/graphs:** `pip install matplotlib` then generate and `view_image` to verify
- **Image processing:** Use Pillow to resize, crop, convert formats, or add annotations
- **PDF to images:** Use `pypdf` to extract pages, Pillow to render

## Environment Variables Injected into Sandbox

| Variable | Purpose |
|----------|---------|
| `ARKE_API_URL` | API base URL (auto-configured) |
| `ARKE_API_KEY` | Decrypted API key for this worker |
| `PYTHONPATH` | Includes workspace pip-pkgs directory |
| `PIP_TARGET` | Directs pip install to workspace |
| `PIP_BREAK_SYSTEM_PACKAGES` | Allows pip install without venv |
| `HOME` | Set to workspace directory |
| `ARKE_INVOCATION_ID` | Current invocation ID (for nesting) |
| `ARKE_INVOCATION_DEPTH` | Nesting depth |
