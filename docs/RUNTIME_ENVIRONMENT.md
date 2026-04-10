# Runtime Environment

What's inside the worker sandbox — pre-installed tools, file processing capabilities, image handling, and the philosophy behind making workers able to handle any input format.

## Philosophy

Workers are general-purpose agents. Users throw documents, images, data files, and code at them. The platform's job is to make sure the worker can handle whatever comes in — extract content, understand it, and turn it into structured knowledge in the graph.

Three principles:

1. **Pre-install the common stuff.** PDFs, Word docs, spreadsheets, images — these are predictable. Install the packages so the worker doesn't waste iterations on `pip install`.

2. **Let workers self-install the rest.** Edge cases are unpredictable. The sandbox is configured so `pip install <package>` works without special flags. Packages install to the workspace and are available immediately.

3. **Give the LLM eyes.** If the model supports vision, the `view_image` tool sends image content directly to it. The worker can generate charts, extract frames, photograph documents, and actually see what it's working with.

## Docker (Production)

The Docker image is the canonical runtime. It provides Linux namespaces via bubblewrap for real isolation, and has all tools pre-installed at system paths.

### System Tools

| Tool | Path | Purpose |
|------|------|---------|
| `python` / `python3` | `/usr/bin/python3` | Script execution, package management |
| `node` | `/usr/local/bin/node` | JavaScript/TypeScript execution |
| `arkeon` | `/usr/local/bin/arkeon` | Arkeon CLI (built from current OpenAPI spec) |
| `bash` | `/bin/bash` | Shell execution |
| `curl` | `/usr/bin/curl` | HTTP requests |
| `jq` | `/usr/bin/jq` | JSON processing |
| `pip` | `/usr/bin/pip3` | Python package installation |
| `bwrap` | `/usr/bin/bwrap` | Bubblewrap sandbox isolation |

### Arkeon SDKs

| SDK | Import | Location |
|-----|--------|----------|
| TypeScript | `import * as arkeon from '@arkeon-technologies/sdk'` | `/node_modules/@arkeon-technologies/sdk/` |
| TypeScript (alias) | `import * as arkeon from 'arkeon-sdk'` | Symlink to above |
| Python | `import arkeon_sdk as arkeon` | `/usr/local/lib/python3.x/dist-packages/arkeon_sdk/` |

The TypeScript SDK is installed at `/node_modules/` (filesystem root) so Node's ESM resolver finds it from any working directory — including the ephemeral workspace directories created for each invocation.

### Pre-installed Python Packages

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

## Local Development

### Use Docker

For worker testing, always use Docker. The local macOS fallback lacks bwrap isolation, has a potentially stale CLI binary, and doesn't have the SDKs installed at the right paths.

```bash
# Full stack: api + postgres + meilisearch + redis + migrate
docker compose up -d --build

# With hot-reload (syncs source changes, rebuilds on CLI/SDK changes)
docker compose up --watch
```

### Docker Compose Watch

The compose file supports `develop.watch` for a smooth dev loop:

- **`sync`**: API, runtime, and shared source changes are synced into the container — tsx watch picks them up and restarts automatically
- **`rebuild`**: CLI, SDK, or dependency changes trigger a full image rebuild (~2-18s with layer caching)

### What's Different Locally (without Docker)

| Feature | Docker | Local (macOS) |
|---------|--------|---------------|
| bwrap isolation | Yes | No (direct execution fallback) |
| CLI binary | Current (built during Docker build) | Whatever's in `$PATH` (may be stale) |
| TypeScript SDK | Installed at `/node_modules/` | Not installed globally |
| Python SDK | pip-installed | Not installed |
| Python packages | All pre-installed | None |
| `pip install` in sandbox | Works (writable workspace) | Works but no bwrap |

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

## Adding New Pre-installed Packages

Edit the `Dockerfile` `pip install` line in the `app` stage:

```dockerfile
RUN pip install --break-system-packages --no-cache-dir \
    /tmp/sdk-python \
    reportlab pypdf python-docx openpyxl python-pptx \
    ebooklib beautifulsoup4 lxml \
    Pillow pandas markdown chardet \
    NEW_PACKAGE_HERE \
    && rm -rf /tmp/sdk-python
```

Then update the "Pre-installed Python packages" list in the worker prompt (`packages/api/src/lib/worker-prompt.ts`) so workers know it's available.

Keep the image reasonable — install packages that workers would commonly need. Niche packages should be self-installed at runtime.
