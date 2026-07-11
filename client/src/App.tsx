import { useEffect, useId, useMemo, useRef, useState } from "react";

type AppConfig = {
  authEnabled: boolean;
  verificationEnabled: boolean;
  turnstileSiteKey: string | null;
  maxUploadMb: number;
  maxImagePixels: number;
  rateLimitWindowMinutes: number;
  rateLimitMaxRequests: number;
  acceptableUseVersion: string;
};

type SessionState = {
  authEnabled: boolean;
  signedIn: boolean;
  policyAccepted: boolean;
  acceptableUseVersion: string;
  user: {
    login: string;
    displayName: string;
    email: string;
  } | null;
};

type LoadState = "idle" | "loading" | "success" | "error";

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
          theme?: "light";
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

function formatPixels(pixelCount: number) {
  const megapixels = pixelCount / 1_000_000;

  if (megapixels >= 1) {
    return `${megapixels.toFixed(megapixels >= 10 ? 0 : 1)} MP`;
  }

  return `${pixelCount.toLocaleString()} px`;
}

function useTurnstile(siteKey: string | null, enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!siteKey || !enabled) {
      setToken("");
      return;
    }

    const scriptId = "cf-turnstile-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;

    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    const mountWidget = () => {
      if (!containerRef.current || !window.turnstile || widgetIdRef.current) {
        return;
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (nextToken) => setToken(nextToken),
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken(""),
        theme: "light",
      });
    };

    if (window.turnstile) {
      mountWidget();
      return;
    }

    script.addEventListener("load", mountWidget);

    return () => {
      script?.removeEventListener("load", mountWidget);

      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [enabled, siteKey]);

  const reset = () => {
    setToken("");

    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  };

  return {
    containerRef,
    token,
    reset,
  };
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [configError, setConfigError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [resultMeta, setResultMeta] = useState<{ width: number; height: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const formId = useId();

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch("/api/config").then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load app configuration.");
        }

        return response.json() as Promise<AppConfig>;
      }),
      fetch("/api/session").then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load the current session.");
        }

        return response.json() as Promise<SessionState>;
      }),
    ])
      .then(([nextConfig, nextSession]) => {
        if (!cancelled) {
          setConfig(nextConfig);
          setSession(nextSession);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setConfigError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
    };
  }, [downloadUrl]);

  const verificationEnabled = Boolean(config?.verificationEnabled);
  const authEnabled = Boolean(config?.authEnabled);
  const isSignedIn = Boolean(session?.signedIn);
  const policyAccepted = Boolean(session?.policyAccepted);
  const { containerRef, token, reset } = useTurnstile(
    config?.turnstileSiteKey ?? null,
    verificationEnabled,
  );

  const helperText = useMemo(() => {
    if (!config) {
      return "Loading upload policy...";
    }

    return `JPG, PNG, WEBP, HEIC, TIFF up to ${config.maxUploadMb} MB`;
  }, [config]);

  const onFileChange = (file: File | null) => {
    setSelectedFile(file);
    setErrorMessage("");
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedFile) {
      setErrorMessage("Choose an image before processing.");
      return;
    }

    if (authEnabled && !isSignedIn) {
      setErrorMessage("Sign in before processing images.");
      return;
    }

    if (!policyAccepted) {
      setErrorMessage("Accept the usage policy before processing.");
      return;
    }

    if (verificationEnabled && !token) {
      setErrorMessage("Complete verification before processing.");
      return;
    }

    const body = new FormData();
    body.append("image", selectedFile);

    if (token) {
      body.append("turnstileToken", token);
    }

    setStatus("loading");
    setErrorMessage("");

    try {
      const response = await fetch("/api/remove-background", {
        method: "POST",
        body,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Image processing failed.");
      }

      const blob = await response.blob();
      const nextUrl = URL.createObjectURL(blob);
      const width = Number(response.headers.get("X-Image-Width") ?? 0);
      const height = Number(response.headers.get("X-Image-Height") ?? 0);

      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }

      setDownloadUrl(nextUrl);
      setResultMeta(width && height ? { width, height } : null);
      setDownloadName(`${selectedFile.name.replace(/\.[^.]+$/, "")}.transparent.png`);
      setStatus("success");
      reset();
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Image processing failed.");
      reset();
    }
  };

  const acceptPolicy = async () => {
    setErrorMessage("");

    try {
      const response = await fetch("/api/accept-policy", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ accepted: true }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not record policy acceptance.");
      }

      setSession((await response.json()) as SessionState);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not record policy acceptance.");
    }
  };

  const logout = async () => {
    await fetch("/auth/logout", {
      method: "POST",
    });

    setSession((currentSession) =>
      currentSession
        ? {
            ...currentSession,
            signedIn: false,
            policyAccepted: false,
            user: null,
          }
        : currentSession,
    );
  };

  return (
    <main className="shell">
      <section className="hero">
        <div className="brand-row">
          <div className="brand-lockup">
            <span className="brand-wordmark">Cutout</span>
            <span className="brand-mark">studio</span>
          </div>
          <div className="top-rail">
            <div className="brand-note">Portrait-focused removal with guardrails</div>
            {session?.user ? (
              <button className="secondary-button" onClick={logout} type="button">
                Sign out {session.user.login}
              </button>
            ) : null}
          </div>
        </div>

        <div className="layout">
          <section className="intro-card">
            <p className="eyebrow">Free beta access with identity checks</p>
            <h1>Cut the background, keep the person.</h1>
            <p className="lede">
              Free to use does not have to mean anonymous. This upload flow can require
              GitHub sign-in, verified email, acceptable-use acceptance, Turnstile, and
              bounded per-user quotas before a portrait is processed.
            </p>

            <div className="signal-list">
              <article>
                <h2>Usage stays bounded</h2>
                <p>
                  The API rejects oversized files, enforces MIME checks, and rate-limits
                  repeated processing requests.
                </p>
              </article>
              <article>
                <h2>Identity is accountable</h2>
                <p>
                  GitHub OAuth can require a verified email before a session is allowed to
                  process images, which is stronger than anonymous captchas alone.
                </p>
              </article>
              <article>
                <h2>Use policy is enforceable</h2>
                <p>
                  The server will not process uploads until the current acceptable-use
                  version has been acknowledged for the active session.
                </p>
              </article>
            </div>
          </section>

          <section className="workbench">
            <div className="upload-panel">
              <div className="panel-header">
                <div>
                  <p className="panel-label">Uploader</p>
                  <h2>Process one portrait at a time</h2>
                </div>
                <span className="policy-pill">
                  {authEnabled ? "Login required" : verificationEnabled ? "Verification required" : "Local mode"}
                </span>
              </div>

              <form id={formId} className="upload-form" onSubmit={onSubmit}>
                {config && authEnabled && !isSignedIn ? (
                  <div className="gate-card">
                    <div className="turnstile-copy">
                      <strong>Sign in before upload</strong>
                      <span>
                        Free access is tied to a verified GitHub email so abusive or illegal
                        use is harder to do anonymously.
                      </span>
                    </div>
                    <a className="auth-link" href="/auth/github">
                      Continue with GitHub
                    </a>
                  </div>
                ) : null}

                {session?.user && !policyAccepted ? (
                  <div className="gate-card gate-card-policy">
                    <div className="turnstile-copy">
                      <strong>Accept the usage policy</strong>
                      <span>
                        You must confirm that you own the image or have permission to edit it,
                        and that you will not use the tool for illegal, exploitative, or abusive
                        content. Policy version: {config?.acceptableUseVersion}
                      </span>
                    </div>
                    <button className="secondary-button" onClick={acceptPolicy} type="button">
                      Accept and continue
                    </button>
                  </div>
                ) : null}

                <label
                  className={`dropzone${dragActive ? " drag-active" : ""}`}
                  onDragEnter={() => setDragActive(true)}
                  onDragLeave={() => setDragActive(false)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragActive(false);
                    onFileChange(event.dataTransfer.files[0] ?? null);
                  }}
                >
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/tiff"
                    onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
                  />
                  <div className="drop-icon" aria-hidden="true">
                    ↑
                  </div>
                  <strong>{selectedFile ? selectedFile.name : "Drag a portrait here"}</strong>
                  <span>{selectedFile ? `${selectedFile.size.toLocaleString()} bytes` : helperText}</span>
                </label>

                {config && verificationEnabled ? (
                  <div className="turnstile-block">
                    <div className="turnstile-copy">
                      <strong>Verification</strong>
                      <span>Complete the challenge before the request is accepted.</span>
                    </div>
                    <div ref={containerRef} />
                  </div>
                ) : (
                  <div className="turnstile-block turnstile-passive">
                    <div className="turnstile-copy">
                      <strong>{authEnabled ? "Verification layer" : "Verification"}</strong>
                      <span>
                        {config
                          ? "Turnstile is disabled in this environment. Add site and secret keys to enforce it."
                          : "Loading verification policy..."}
                      </span>
                    </div>
                  </div>
                )}

                <div className="actions">
                  <button
                    type="submit"
                    disabled={
                      status === "loading" ||
                      Boolean(configError) ||
                      (authEnabled && !isSignedIn) ||
                      !policyAccepted
                    }
                  >
                    {status === "loading" ? "Removing background..." : "Choose and process"}
                  </button>
                  <span className="status-copy">
                    {status === "success"
                      ? "Transparent PNG ready."
                      : status === "loading"
                        ? "Processing on the server..."
                        : authEnabled && !isSignedIn
                          ? "Sign in with GitHub to unlock processing."
                          : !policyAccepted
                            ? "Accept the policy to unlock processing."
                            : "Supported for portrait photos."}
                  </span>
                </div>
              </form>

              {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
              {configError ? <p className="error-banner">{configError}</p> : null}
            </div>

            <aside className="limits-card">
              <div className="panel-header compact">
                <div>
                  <p className="panel-label">Usage limits</p>
                  <h2>Enforced at the API edge</h2>
                </div>
              </div>

              {config ? (
                <dl className="limits-grid">
                  <div>
                    <dt>Window</dt>
                    <dd>{config.rateLimitWindowMinutes} minutes</dd>
                  </div>
                  <div>
                    <dt>Requests</dt>
                    <dd>{config.rateLimitMaxRequests} per user or IP</dd>
                  </div>
                  <div>
                    <dt>File size</dt>
                    <dd>Up to {config.maxUploadMb} MB</dd>
                  </div>
                  <div>
                    <dt>Image ceiling</dt>
                    <dd>{formatPixels(config.maxImagePixels)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="placeholder-copy">Loading policy details...</p>
              )}
            </aside>

            <section className="result-panel">
              <div className="panel-header">
                <div>
                  <p className="panel-label">Result</p>
                  <h2>Transparent PNG preview</h2>
                </div>
                {downloadUrl ? (
                  <a className="download-link" href={downloadUrl} download={downloadName}>
                    Download PNG
                  </a>
                ) : null}
              </div>

              <div className="preview-stage">
                {downloadUrl ? (
                  <img src={downloadUrl} alt="Processed portrait with transparent background" />
                ) : (
                  <div className="empty-preview">
                    <p>
                      The processed cutout appears here after a successful request from a
                      signed-in, policy-approved session.
                    </p>
                  </div>
                )}
              </div>

              <div className="result-meta">
                <span>{selectedFile ? `Source: ${selectedFile.name}` : "No file selected"}</span>
                <span>
                  {resultMeta ? `${resultMeta.width} × ${resultMeta.height}` : "PNG output"}
                </span>
              </div>
            </section>
          </section>
        </div>
      </section>
    </main>
  );
}
