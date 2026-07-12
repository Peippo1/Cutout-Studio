import { useEffect, useId, useMemo, useRef, useState } from "react";

type AppConfig = {
  authEnabled: boolean;
  verificationEnabled: boolean;
  moderationActive: boolean;
  turnstileSiteKey: string | null;
  maxUploadMb: number;
  maxImagePixels: number;
  rateLimitWindowMinutes: number;
  rateLimitMaxRequests: number;
  acceptableUseVersion: string;
};

type UserStatus = "active" | "blocked" | "review_required";

type SessionState = {
  authEnabled: boolean;
  signedIn: boolean;
  policyAccepted: boolean;
  acceptableUseVersion: string;
  isAdmin: boolean;
  moderationActive: boolean;
  userStatus: UserStatus | null;
  user: {
    id: string;
    login: string;
    displayName: string;
    email: string;
    status: UserStatus;
  } | null;
};

type AdminQueue = {
  events: Array<{
    eventType: string;
    requestId: string;
    status: string;
    reasonCode: string | null;
    createdAt: string;
    userId: string | null;
  }>;
  reports: Array<{
    id: string;
    reporterUserId: string;
    targetRequestId: string | null;
    reason: string;
    status: string;
    createdAt: string;
  }>;
  users: Array<{
    id: string;
    login: string;
    email: string;
    status: UserStatus;
  }>;
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

  return {
    containerRef,
    token,
    reset() {
      setToken("");

      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    },
  };
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [adminQueue, setAdminQueue] = useState<AdminQueue | null>(null);
  const [configError, setConfigError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [resultMeta, setResultMeta] = useState<{ width: number; height: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [latestRequestId, setLatestRequestId] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [reportTargetId, setReportTargetId] = useState("");
  const [reportMessage, setReportMessage] = useState("");
  const formId = useId();

  const refreshSession = async () => {
    const nextSession = (await fetch("/api/session").then((response) => {
      if (!response.ok) {
        throw new Error("Failed to load the current session.");
      }

      return response.json() as Promise<SessionState>;
    })) as SessionState;
    setSession(nextSession);
    return nextSession;
  };

  const loadAdminQueue = async () => {
    const response = await fetch("/api/admin/review");

    if (!response.ok) {
      throw new Error("Failed to load the admin review queue.");
    }

    setAdminQueue((await response.json()) as AdminQueue);
  };

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
      .then(async ([nextConfig, nextSession]) => {
        if (cancelled) {
          return;
        }

        setConfig(nextConfig);
        setSession(nextSession);

        if (nextSession.isAdmin) {
          await loadAdminQueue().catch(() => null);
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
  const isBlocked = session?.userStatus === "blocked";
  const isReviewRequired = session?.userStatus === "review_required";
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

    if (isBlocked) {
      setErrorMessage("This account is blocked from processing images.");
      return;
    }

    if (isReviewRequired) {
      setErrorMessage("This account requires manual review before processing can continue.");
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
    setReportMessage("");

    try {
      const response = await fetch("/api/remove-background", {
        method: "POST",
        body,
      });
      const requestId = response.headers.get("x-request-id") ?? "";
      setLatestRequestId(requestId);
      setReportTargetId(requestId);

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; requestId?: string }
          | null;
        setLatestRequestId(payload?.requestId ?? requestId);
        setReportTargetId(payload?.requestId ?? requestId);
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
      await refreshSession();
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Image processing failed.");
      reset();
      await refreshSession().catch(() => null);
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

    setAdminQueue(null);
    setSession((currentSession) =>
      currentSession
        ? {
            ...currentSession,
            signedIn: false,
            policyAccepted: false,
            isAdmin: false,
            userStatus: null,
            user: null,
          }
        : currentSession,
    );
  };

  const submitAbuseReport = async () => {
    setReportMessage("");

    try {
      const response = await fetch("/api/report-abuse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetRequestId: reportTargetId,
          reason: reportReason,
        }),
      });
      const payload = (await response.json()) as
        | { error?: string; requestId?: string; report?: { id: string } }
        | undefined;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not submit the report.");
      }

      setReportMessage(`Report submitted. Reference ${payload?.report?.id ?? payload?.requestId ?? ""}.`);
      setReportReason("");

      if (session?.isAdmin) {
        await loadAdminQueue().catch(() => null);
      }
    } catch (error) {
      setReportMessage(error instanceof Error ? error.message : "Could not submit the report.");
    }
  };

  const updateUserStatus = async (userId: string, action: "block_user" | "reinstate_user") => {
    const response = await fetch(`/api/admin/users/${userId}/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? "Admin action failed.");
    }

    await loadAdminQueue();
    await refreshSession();
  };

  const markReportReviewed = async (reportId: string) => {
    const response = await fetch(`/api/admin/reports/${reportId}/review`, {
      method: "POST",
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? "Could not review the report.");
    }

    await loadAdminQueue();
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
            <div className="brand-note">Verified beta with moderation and audit logging</div>
            {session?.user ? (
              <button className="secondary-button" onClick={logout} type="button">
                Sign out {session.user.login}
              </button>
            ) : null}
          </div>
        </div>

        <div className="layout">
          <section className="intro-card">
            <p className="eyebrow">Free beta with accountable access</p>
            <h1>Remove the background. Keep the standards.</h1>
            <p className="lede">
              Cutout Studio is intentionally not an anonymous utility. Processing can require
              verified GitHub sign-in, policy acceptance, Turnstile, automated moderation, and
              audit logging before a portrait is touched.
            </p>

            <div className="signal-list">
              <article>
                <h2>Uploads are screened first</h2>
                <p>
                  Moderation runs before background removal so disallowed or uncertain images are
                  stopped before any cutout work happens.
                </p>
              </article>
              <article>
                <h2>No image retention by default</h2>
                <p>
                  Raw uploads and output PNGs stay out of storage. The service keeps only minimal
                  audit metadata, decision codes, and request identifiers.
                </p>
              </article>
              <article>
                <h2>Abuse has consequences</h2>
                <p>
                  Usage is logged, reports are reviewable, and accounts can be blocked or placed
                  into manual review when activity crosses the line.
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
                  {isBlocked
                    ? "Account blocked"
                    : isReviewRequired
                      ? "Manual review"
                      : authEnabled
                        ? "Verified beta"
                        : "Local mode"}
                </span>
              </div>

              <form id={formId} className="upload-form" onSubmit={onSubmit}>
                {config && authEnabled && !isSignedIn ? (
                  <div className="gate-card">
                    <div className="turnstile-copy">
                      <strong>Sign in before upload</strong>
                      <span>
                        Free access is tied to a verified GitHub email so misuse is harder to do
                        anonymously and repeated abuse can be traced to an account.
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
                        You must confirm that you own the image or are permitted to edit it, that
                        you will not use the tool for illegal, exploitative, or abusive content,
                        and that usage is logged with request identifiers. Policy version:{" "}
                        {config?.acceptableUseVersion}
                      </span>
                    </div>
                    <button className="secondary-button" onClick={acceptPolicy} type="button">
                      Accept and continue
                    </button>
                  </div>
                ) : null}

                {isBlocked || isReviewRequired ? (
                  <div className="gate-card gate-card-policy">
                    <div className="turnstile-copy">
                      <strong>{isBlocked ? "Processing disabled" : "Manual review required"}</strong>
                      <span>
                        {isBlocked
                          ? "This account cannot process additional images. If this is unexpected, contact the operator with your latest request ID."
                          : "Recent activity requires operator review before more images can be processed."}
                      </span>
                    </div>
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
                      !policyAccepted ||
                      isBlocked ||
                      isReviewRequired
                    }
                  >
                    {status === "loading" ? "Removing background..." : "Choose and process"}
                  </button>
                  <span className="status-copy">
                    {status === "success"
                      ? "Transparent PNG ready."
                      : status === "loading"
                        ? "Running moderation and cutout..."
                        : authEnabled && !isSignedIn
                          ? "Sign in with GitHub to unlock processing."
                          : isBlocked
                            ? "This account is blocked."
                            : isReviewRequired
                              ? "This account needs manual review."
                              : !policyAccepted
                                ? "Accept the policy to unlock processing."
                                : "Supported for portrait photos."}
                  </span>
                </div>
              </form>

              {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
              {configError ? <p className="error-banner">{configError}</p> : null}
              {latestRequestId ? <p className="request-id">Request ID: {latestRequestId}</p> : null}
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
                  <div>
                    <dt>Moderation</dt>
                    <dd>{config.moderationActive ? "Active before processing" : "Disabled here"}</dd>
                  </div>
                  <div>
                    <dt>Policy</dt>
                    <dd>{config.acceptableUseVersion}</dd>
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
                      The processed cutout appears here after a successful request from a verified,
                      policy-approved session that passes the safety checks.
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

            {session?.signedIn ? (
              <section className="result-panel report-panel">
                <div className="panel-header">
                  <div>
                    <p className="panel-label">Safety</p>
                    <h2>Report misuse</h2>
                  </div>
                </div>
                <div className="report-grid">
                  <label>
                    Request ID
                    <input
                      value={reportTargetId}
                      onChange={(event) => setReportTargetId(event.target.value)}
                      placeholder="req_..."
                    />
                  </label>
                  <label>
                    Reason
                    <textarea
                      value={reportReason}
                      onChange={(event) => setReportReason(event.target.value)}
                      placeholder="Why does this request look abusive or unsafe?"
                      rows={4}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    onClick={submitAbuseReport}
                    type="button"
                    disabled={reportReason.trim().length < 8}
                  >
                    Submit report
                  </button>
                  {reportMessage ? <p className="status-copy">{reportMessage}</p> : null}
                </div>
              </section>
            ) : null}

            {session?.isAdmin ? (
              <section className="result-panel admin-panel">
                <div className="panel-header">
                  <div>
                    <p className="panel-label">Admin review</p>
                    <h2>Recent safety queue</h2>
                  </div>
                  <button className="secondary-button" onClick={() => loadAdminQueue()} type="button">
                    Refresh
                  </button>
                </div>

                {adminQueue ? (
                  <div className="admin-grid">
                    <div className="admin-column">
                      <h3>Flagged events</h3>
                      {adminQueue.events.map((event) => (
                        <article className="admin-card" key={`${event.requestId}-${event.createdAt}`}>
                          <strong>{event.eventType}</strong>
                          <span>{event.reasonCode ?? "n/a"}</span>
                          <span>{event.requestId}</span>
                          <span>{formatTimestamp(event.createdAt)}</span>
                        </article>
                      ))}
                    </div>

                    <div className="admin-column">
                      <h3>Abuse reports</h3>
                      {adminQueue.reports.map((report) => (
                        <article className="admin-card" key={report.id}>
                          <strong>Report {report.id}</strong>
                          <span>{report.targetRequestId ?? "No request ID"}</span>
                          <span>{report.reason}</span>
                          <button
                            className="secondary-button"
                            onClick={() => markReportReviewed(report.id)}
                            type="button"
                          >
                            Mark reviewed
                          </button>
                        </article>
                      ))}
                    </div>

                    <div className="admin-column">
                      <h3>Managed accounts</h3>
                      {adminQueue.users.map((user) => (
                        <article className="admin-card" key={user.id}>
                          <strong>{user.login}</strong>
                          <span>{user.email}</span>
                          <span>Status: {user.status}</span>
                          <div className="admin-actions">
                            <button
                              className="secondary-button"
                              onClick={() => updateUserStatus(user.id, "block_user")}
                              type="button"
                            >
                              Block
                            </button>
                            <button
                              className="secondary-button"
                              onClick={() => updateUserStatus(user.id, "reinstate_user")}
                              type="button"
                            >
                              Reinstate
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="placeholder-copy">Loading the review queue...</p>
                )}
              </section>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
