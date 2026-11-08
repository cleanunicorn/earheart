// Starter vocabulary packs (#72): curated, toggleable term lists for common
// stacks. A pack is not copied into the dictionary; the ids the user enabled
// live in cleanup.vocabPacks and promptTerms (main/cleanup-styles.js) appends
// their terms after the user's own, so switching a pack off removes exactly
// its terms and the user's dictionary is never touched.
//
// Loaded as a classic script by the settings window and required by main, like
// vocabulary.js and aliases.js. Only distinctive spellings belong here: a pack
// term that is also an ordinary word ("token", "prompt") invites the cleanup
// model to force it in where the speaker said something else.

const PACK_TERMS_MAX = 40; // per pack, enforced by packTerms and pinned by a test
const PROMPT_TERMS_MAX = 400; // all terms in the cleanup prompt; see mergePromptTerms

const VOCAB_PACKS = [
  {
    id: "coding-agents",
    label: "Coding agents",
    terms: ["Claude Code", "Codex", "Cursor", "Copilot", "Windsurf", "Aider", "OpenCode", "Gemini CLI",
      "MCP", "LLM", "LLMs", "RAG", "Anthropic", "OpenAI", "Claude", "Sonnet", "Opus", "Haiku",
      "AGENTS.md", "CLAUDE.md", "subagent", "worktree", "GitHub", "pull request", "CI", "SDK", "CLI",
      "API", "JSON", "YAML", "regex", "README", "monorepo", "Ollama", "llama.cpp"],
  },
  {
    id: "js-web",
    label: "JS / Web",
    terms: ["JavaScript", "TypeScript", "Node.js", "npm", "pnpm", "Yarn", "Bun", "Deno", "Vite", "Vitest",
      "Webpack", "esbuild", "ESLint", "Prettier", "React", "Next.js", "Vue", "Svelte", "Tailwind",
      "Express", "Fastify", "Prisma", "Zod", "useEffect", "useState", "useRef", "useMemo", "useCallback",
      "JSX", "TSX", "CSS", "HTML", "DOM", "Electron", "Playwright", "tsconfig"],
  },
  {
    id: "cloud-k8s",
    label: "Cloud / Kubernetes",
    terms: ["kubectl", "Kubernetes", "Helm", "Terraform", "Docker", "Dockerfile", "docker-compose",
      "Kustomize", "Argo CD", "Istio", "Prometheus", "Grafana", "AWS", "GCP", "Azure", "S3", "EC2",
      "EKS", "GKE", "IAM", "VPC", "Lambda", "CloudFormation", "Pulumi", "Ansible", "nginx", "Envoy",
      "etcd", "kubeconfig", "StatefulSet", "DaemonSet", "Ingress", "YAML", "k9s"],
  },
  {
    id: "python-data",
    label: "Python / Data",
    terms: ["Python", "uv", "pip", "pipx", "Poetry", "pyproject.toml", "pytest", "Ruff", "mypy",
      "pandas", "NumPy", "SciPy", "Jupyter", "PyTorch", "TensorFlow", "scikit-learn", "Hugging Face",
      "Transformers", "FastAPI", "Flask", "Django", "Pydantic", "SQLAlchemy", "Polars", "DuckDB",
      "Matplotlib", "asyncio", "ONNX", "CUDA", "venv", "conda"],
  },
];

const PACK_IDS = VOCAB_PACKS.map((pack) => pack.id);

// The enabled ids that name a pack that exists, once each, in pack order. An
// id a later version dropped (or a hand edit invented) is ignored, never an error.
function enabledPacks(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  return VOCAB_PACKS.filter((pack) => wanted.has(pack.id));
}

// Terms of the enabled packs: each pack's first PACK_TERMS_MAX terms, once each
// across packs.
function packTerms(ids) {
  const out = [];
  const seen = new Set();
  for (const pack of enabledPacks(ids)) {
    for (const term of pack.terms.slice(0, PACK_TERMS_MAX)) {
      if (!seen.has(term)) { seen.add(term); out.push(term); }
    }
  }
  return out;
}

// The user's terms (never trimmed: they chose them) followed by pack terms that
// are new, only while the whole list stays within PROMPT_TERMS_MAX. A prompt
// that is already over the cap from the user's own list gets no pack terms.
function mergePromptTerms(userTerms, ids) {
  const seen = new Set(userTerms);
  const out = [...userTerms];
  for (const term of packTerms(ids)) {
    if (out.length >= PROMPT_TERMS_MAX) break;
    if (!seen.has(term)) { seen.add(term); out.push(term); }
  }
  return out;
}

// Normalise a stored cleanup.vocabPacks: known ids only, once each.
function normalizePackIds(ids) {
  return enabledPacks(ids).map((pack) => pack.id);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    VOCAB_PACKS, PACK_IDS, PACK_TERMS_MAX, PROMPT_TERMS_MAX,
    enabledPacks, packTerms, mergePromptTerms, normalizePackIds,
  };
}
