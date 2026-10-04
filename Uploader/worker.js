const MAX_SOURCE_SIZE = 512 * 1024;
const MAX_NAME_ATTEMPTS = 10;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function randomName(length = 20) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let result = "";

  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }

  return result;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);

  let binary = "";

  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(
      i,
      Math.min(i + chunkSize, bytes.length)
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function githubRequest(
  path,
  options,
  env
) {
  const response = await fetch(
    `https://api.github.com${path}`,
    {
      ...options,

      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Auto-Uploader",
        ...(options.headers || {})
      }
    }
  );

  return response;
}

async function fileExists(
  filename,
  env
) {
  const owner =
    encodeURIComponent(env.GITHUB_OWNER);

  const repo =
    encodeURIComponent(env.GITHUB_REPO);

  const branch =
    encodeURIComponent(env.GITHUB_BRANCH);

  const path =
    encodeURIComponent(filename);

  const response =
    await githubRequest(
      `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      {
        method: "GET"
      },
      env
    );

  if (response.status === 200) {
    return true;
  }

  if (response.status === 404) {
    return false;
  }

  return false;
}

async function generateAvailableFilename(env) {
  for (
    let attempt = 0;
    attempt < MAX_NAME_ATTEMPTS;
    attempt++
  ) {
    const filename =
      `uploads/${randomName(20)}.lua`;

    const exists =
      await fileExists(filename, env);

    if (!exists) {
      return filename;
    }
  }

  throw new Error(
    "Gagal membuat nama file unik."
  );
}

async function handleConvert(request, env) {
  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Method tidak diizinkan."
      },
      405
    );
  }

  if (
    !env.GITHUB_TOKEN ||
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO ||
    !env.GITHUB_BRANCH
  ) {
    return json(
      {
        ok: false,
        error:
          "Environment variable GitHub belum lengkap di Cloudflare."
      },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Request JSON tidak valid."
      },
      400
    );
  }

  const source =
    typeof body.source === "string"
      ? body.source
      : "";

  if (!source.trim()) {
    return json(
      {
        ok: false,
        error: "Source masih kosong."
      },
      400
    );
  }

  if (
    new TextEncoder().encode(source).byteLength >
    MAX_SOURCE_SIZE
  ) {
    return json(
      {
        ok: false,
        error: "Source terlalu besar."
      },
      413
    );
  }

  const filename =
    await generateAvailableFilename(env);

  const content =
    toBase64(source);

  const owner =
    encodeURIComponent(env.GITHUB_OWNER);

  const repo =
    encodeURIComponent(env.GITHUB_REPO);

  const path =
    encodeURIComponent(filename);

  const branch =
    encodeURIComponent(env.GITHUB_BRANCH);

  const response =
    await githubRequest(
      `/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          message:
            `Upload source ${filename}`,
          content,
          branch: env.GITHUB_BRANCH
        })
      },
      env
    );

  const responseText =
    await response.text();

  let githubData = {};

  try {
    githubData =
      responseText
        ? JSON.parse(responseText)
        : {};
  } catch {
    githubData = {};
  }

  if (!response.ok) {
    return json(
      {
        ok: false,
        error:
          githubData.message ||
          "GitHub menolak upload.",
        githubStatus:
          response.status
      },
      502
    );
  }

  const rawUrl =
    `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${filename}`;

  const githubUrl =
    githubData.content?.html_url ||
    `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/blob/${env.GITHUB_BRANCH}/${filename}`;

  return json({
    ok: true,
    filename,
    rawUrl,
    githubUrl
  });
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    if (
      url.pathname === "/api/convert"
    ) {
      try {
        return await handleConvert(
          request,
          env
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error:
              error?.message ||
              "Internal server error."
          },
          500
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
